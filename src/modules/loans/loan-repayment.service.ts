import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import {
  AccountType,
  JournalEntryType,
  LoanStatus,
  Prisma,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { Decimal } from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../accounting/ledger.service';
import {
  ExecuteGuarantorDebitJobPayload,
  GUARANTOR_DEBIT_JOB,
  QUEUE_NAMES,
} from '../queue/queue.constants';

export interface ProcessRepaymentInput {
  tenantId: string;
  amount: Decimal;
  reference: string;
  processedBy: string;
  memberId?: string | null;
  loanId?: string | null;
  loanNumber?: string | null;
  accountReference?: string | null;
  mpesaTxId?: string;
  receipt?: string;
  resultCode?: number;
  resultDesc?: string;
  callbackPayload?: Prisma.InputJsonValue;
  transactionDate?: Date;
}

export interface RepaymentAllocationSummary {
  loanId: string;
  loanNumber: string;
  allocatedToPenalty: Decimal;
  allocatedToInterest: Decimal;
  allocatedToPrincipal: Decimal;
  overpaymentToFosa: Decimal;
  outstandingBalance: Decimal;
  status: LoanStatus;
}

interface LockedLoanRow {
  id: string;
  loanNumber: string | null;
  memberId: string;
  status: string;
  outstandingBalance: string;
  accruedInterest: string;
  arrearsAmount: string;
  totalRepaid: string;
}

interface LockedAccountRow {
  id: string;
  balance: string;
}

@Injectable()
export class LoanRepaymentService {
  private readonly logger = new Logger(LoanRepaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    @InjectQueue(QUEUE_NAMES.GUARANTOR_RECOVERY)
    private readonly guarantorRecoveryQueue: Queue<ExecuteGuarantorDebitJobPayload>,
  ) {}

  async validateLoanForRepayment(
    loanReference: string,
    tenantId: string,
  ): Promise<{ id: string; status: LoanStatus }> {
    const loanNumber = loanReference.replace(/^LOAN-/, '');
    const loan = await this.prisma.loan.findFirst({
      where: { loanNumber, tenantId },
      select: { id: true, status: true },
    });
    if (!loan) {
      throw new NotFoundException(`Loan "${loanNumber}" not found`);
    }

    const repayableStatuses: LoanStatus[] = [LoanStatus.DISBURSED, LoanStatus.ACTIVE];
    if (!repayableStatuses.includes(loan.status)) {
      throw new BadRequestException(`Loan "${loanNumber}" is not in a repayable state`);
    }

    return loan;
  }

  async processRepayment(input: ProcessRepaymentInput): Promise<RepaymentAllocationSummary> {
    if (!input.amount.isFinite() || input.amount.lessThanOrEqualTo(0)) {
      throw new BadRequestException('INVALID_REPAYMENT_AMOUNT');
    }

    const amount = input.amount.toDecimalPlaces(4);
    const txClient = this.prisma.direct ?? this.prisma;
    let auditPayload: Record<string, unknown> | null = null;

    let result: RepaymentAllocationSummary;
    try {
      result = await txClient.$transaction(
        async (tx): Promise<RepaymentAllocationSummary> => {
          const duplicate = await tx.transaction.findFirst({
            where: { tenantId: input.tenantId, reference: input.reference },
          });
          if (duplicate?.loanId) {
            const loan = await tx.loan.findFirst({
              where: { id: duplicate.loanId, tenantId: input.tenantId },
              select: { id: true, loanNumber: true, outstandingBalance: true, status: true },
            });
            if (!loan) {
              throw new NotFoundException('Existing repayment loan not found');
            }
            return {
              loanId: loan.id,
              loanNumber: loan.loanNumber,
              allocatedToPenalty: new Decimal(0),
              allocatedToInterest: new Decimal(0),
              allocatedToPrincipal: new Decimal(duplicate.amount.toString()),
              overpaymentToFosa: new Decimal(0),
              outstandingBalance: new Decimal(loan.outstandingBalance.toString()),
              status: loan.status,
            };
          }

          const loan = await this.lockTargetLoan(tx, input);
          const account = await this.lockFosaAccount(tx, input.tenantId, loan.memberId);

          const outstandingBefore = new Decimal(loan.outstandingBalance);
          const interestBefore = new Decimal(loan.accruedInterest);
          const penaltyBefore = new Decimal(loan.arrearsAmount);
          const totalOwed = penaltyBefore
            .plus(interestBefore)
            .plus(outstandingBefore)
            .toDecimalPlaces(4);

          let remaining = amount;
          const toPenalty = Decimal.min(remaining, penaltyBefore).toDecimalPlaces(4);
          remaining = remaining.minus(toPenalty).toDecimalPlaces(4);
          const toInterest = Decimal.min(remaining, interestBefore).toDecimalPlaces(4);
          remaining = remaining.minus(toInterest).toDecimalPlaces(4);
          const toPrincipal = Decimal.min(remaining, outstandingBefore).toDecimalPlaces(4);
          remaining = remaining.minus(toPrincipal).toDecimalPlaces(4);
          const overpayment = remaining.greaterThan(0) ? remaining : new Decimal(0);

          await this.applyInstallmentAllocation(tx, input.tenantId, loan.id, {
            penalty: toPenalty,
            interest: toInterest,
            principal: toPrincipal,
          });

          const newPenalty = penaltyBefore.minus(toPenalty).toDecimalPlaces(4);
          const newInterest = interestBefore.minus(toInterest).toDecimalPlaces(4);
          const newPrincipal = outstandingBefore.minus(toPrincipal).toDecimalPlaces(4);
          const residualDefaultAmount = newPenalty
            .plus(newInterest)
            .plus(newPrincipal)
            .toDecimalPlaces(4);
          const newStatus = newPrincipal.lessThanOrEqualTo(0)
            ? LoanStatus.FULLY_PAID
            : loan.status === LoanStatus.DEFAULTED && residualDefaultAmount.greaterThan(0)
              ? LoanStatus.DEFAULTED
              : LoanStatus.ACTIVE;

          const ledgerIds: string[] = [];
          const balanceBefore = new Decimal(account.balance);
          let balanceAfter = balanceBefore;

          // Penalty/interest/principal legs never touch the FOSA balance — this money
          // arrives externally (M-Pesa/cash) and is applied directly against the loan's
          // own fields. Each leg gets its own operational Transaction row (unchanged,
          // for the member statement) plus a GL-only posting (Cash vs Income/Receivable)
          // via LedgerService — see postLoanRepaymentLegEntry() for why postEntry()
          // (which always touches an Account balance) isn't the right tool here.
          if (toPenalty.greaterThan(0)) {
            const penaltyTxnId = await this.createAllocationTransaction(
              tx,
              input,
              account.id,
              loan.id,
              toPenalty,
              balanceBefore,
              'PENALTY',
              'Penalty allocation',
            );
            ledgerIds.push(penaltyTxnId);
            await this.ledger.postLoanRepaymentLegEntry({
              tx,
              tenantId: input.tenantId,
              reference: `${input.reference}-PENALTY`,
              leg: 'PENALTY',
              amount: toPenalty,
              transactionId: penaltyTxnId,
              actorId: input.processedBy,
            });
          }
          if (toInterest.greaterThan(0)) {
            const interestTxnId = await this.createAllocationTransaction(
              tx,
              input,
              account.id,
              loan.id,
              toInterest,
              balanceBefore,
              'INTEREST_EARNED',
              'Interest allocation',
            );
            ledgerIds.push(interestTxnId);
            await this.ledger.postLoanRepaymentLegEntry({
              tx,
              tenantId: input.tenantId,
              reference: `${input.reference}-INTEREST`,
              leg: 'INTEREST',
              amount: toInterest,
              transactionId: interestTxnId,
              actorId: input.processedBy,
            });
          }
          if (toPrincipal.greaterThan(0)) {
            const principalTxnId = await this.createAllocationTransaction(
              tx,
              input,
              account.id,
              loan.id,
              toPrincipal,
              balanceBefore,
              'LOAN_REPAYMENT',
              'Principal allocation',
            );
            ledgerIds.push(principalTxnId);
            await this.ledger.postLoanRepaymentLegEntry({
              tx,
              tenantId: input.tenantId,
              reference: `${input.reference}-PRINCIPAL`,
              leg: 'PRINCIPAL',
              amount: toPrincipal,
              transactionId: principalTxnId,
              actorId: input.processedBy,
            });
          }
          if (overpayment.greaterThan(0)) {
            // Genuine overpayment DOES land in the member's FOSA account — this is a
            // plain deposit, so postEntry() (debit CASH, credit FOSA_DEPOSITS) is the
            // right tool, unlike the three legs above.
            const { transaction: overpayTxn } = await this.ledger.postEntry({
              tx,
              tenantId: input.tenantId,
              reference: `${input.reference}-OVERPAY`,
              journalType: JournalEntryType.DEPOSIT,
              accountId: account.id,
              amount: overpayment,
              direction: 'CREDIT',
              actorId: input.processedBy,
              description: `Loan repayment overpayment credited to FOSA ${input.receipt ?? input.reference}`,
              loanId: loan.id,
            });
            ledgerIds.push(overpayTxn.id);
            balanceAfter = new Decimal(overpayTxn.balanceAfter.toString());
          }

          await tx.loan.update({
            where: { id: loan.id },
            data: {
              arrearsAmount: Decimal.max(newPenalty, new Decimal(0)).toString(),
              accruedInterest: Decimal.max(newInterest, new Decimal(0)).toString(),
              outstandingBalance: Decimal.max(newPrincipal, new Decimal(0)).toString(),
              totalRepaid: new Decimal(loan.totalRepaid)
                .plus(toPenalty)
                .plus(toInterest)
                .plus(toPrincipal)
                .toDecimalPlaces(4)
                .toString(),
              status: newStatus,
            },
          });

          if (input.mpesaTxId) {
            await tx.mpesaTransaction.update({
              where: { id: input.mpesaTxId },
              data: {
                transactionId: ledgerIds[0],
                loanId: loan.id,
                status: TransactionStatus.COMPLETED,
                resultCode: input.resultCode ?? 0,
                resultDesc: input.resultDesc ?? 'Success',
                mpesaReceiptNumber: input.receipt,
                transactionDate: input.transactionDate ?? new Date(),
                callbackPayload: input.callbackPayload,
              },
            });
          }

          auditPayload = {
            reference: input.reference,
            loanId: loan.id,
            loanNumber: loan.loanNumber,
            amount: amount.toFixed(4),
            totalOwed: totalOwed.toFixed(4),
            allocatedToPenalty: toPenalty.toFixed(4),
            allocatedToInterest: toInterest.toFixed(4),
            allocatedToPrincipal: toPrincipal.toFixed(4),
            overpaymentToFosa: overpayment.toFixed(4),
            outstandingBalance: Decimal.max(newPrincipal, new Decimal(0)).toFixed(4),
            status: newStatus,
          };

          return {
            loanId: loan.id,
            loanNumber: loan.loanNumber ?? loan.id,
            allocatedToPenalty: toPenalty,
            allocatedToInterest: toInterest,
            allocatedToPrincipal: toPrincipal,
            overpaymentToFosa: overpayment,
            outstandingBalance: Decimal.max(newPrincipal, new Decimal(0)),
            status: newStatus,
          };
        },
        { isolationLevel: 'Serializable' as const },
      );
    } catch (error) {
      // Failure-path audit: a success is worthless as an audit trail if we can't
      // also see what failed and why. Awaited (not fire-and-forget) so the audit
      // write is attempted before the error propagates and the BullMQ job dies —
      // its own catch must never mask the original error.
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.audit
        .create({
          tenantId: input.tenantId,
          actorId: input.processedBy,
          action: 'LOAN.REPAYMENT.FAILED',
          entityType: 'Loan',
          entityId: input.loanId ?? input.loanNumber ?? input.accountReference ?? 'UNKNOWN',
          metadata: {
            reference: input.reference,
            loanId: input.loanId,
            loanNumber: input.loanNumber,
            memberId: input.memberId,
            amount: amount.toFixed(4),
            error_message: errorMessage,
          },
        })
        .catch((auditError: unknown) =>
          this.logger.error(
            `Audit write failed for LOAN.REPAYMENT.FAILED (original error: ${errorMessage})`,
            auditError,
          ),
        );
      throw error;
    }

    if (result.status !== LoanStatus.DEFAULTED) {
      await this.cancelDelayedGuarantorDebit(input.tenantId, result.loanId);
    }

    if (auditPayload) {
      this.audit
        .create({
          tenantId: input.tenantId,
          actorId: input.processedBy,
          action: 'LOAN.REPAYMENT.WATERFALL',
          entityType: 'Loan',
          entityId: result.loanId,
          metadata: auditPayload,
        })
        .catch((error: unknown) =>
          this.logger.warn(
            `Audit emit failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }

    this.logger.log(
      `Repayment allocated tenant=${input.tenantId} loan=${result.loanId} reference=${input.reference} principal=${result.allocatedToPrincipal.toFixed(4)}`,
    );
    return result;
  }

  async cancelDelayedGuarantorDebit(tenantId: string, loanId: string): Promise<void> {
    const delayed = await this.guarantorRecoveryQueue.getDelayed();
    for (const job of delayed) {
      const data = job.data as ExecuteGuarantorDebitJobPayload;
      if (
        data.tenantId === tenantId &&
        data.loanId === loanId &&
        job.name === GUARANTOR_DEBIT_JOB
      ) {
        await job.remove();
        await this.audit.create({
          tenantId,
          actorId: 'SYSTEM',
          action: 'GUARANTOR_RECOVERY.DEBIT_CANCELLED',
          entityType: 'Loan',
          entityId: loanId,
          metadata: { jobId: job.id },
        });
      }
    }
  }

  private async lockTargetLoan(
    tx: Prisma.TransactionClient,
    input: ProcessRepaymentInput,
  ): Promise<LockedLoanRow> {
    const loanNumber = input.loanNumber ?? input.accountReference?.replace(/^LOAN-/, '') ?? null;
    const rows = input.loanId
      ? await tx.$queryRaw<LockedLoanRow[]>`
          SELECT id, "loanNumber", "memberId", status, "outstandingBalance", "accruedInterest", "arrearsAmount", "totalRepaid"
          FROM "Loan"
          WHERE id = ${input.loanId} AND "tenantId" = ${input.tenantId}
          FOR UPDATE
        `
      : loanNumber
        ? await tx.$queryRaw<LockedLoanRow[]>`
            SELECT id, "loanNumber", "memberId", status, "outstandingBalance", "accruedInterest", "arrearsAmount", "totalRepaid"
            FROM "Loan"
            WHERE "loanNumber" = ${loanNumber} AND "tenantId" = ${input.tenantId}
            FOR UPDATE
          `
        : await tx.$queryRaw<LockedLoanRow[]>`
            SELECT id, "loanNumber", "memberId", status, "outstandingBalance", "accruedInterest", "arrearsAmount", "totalRepaid"
            FROM "Loan"
            WHERE "memberId" = ${input.memberId} AND "tenantId" = ${input.tenantId}
              AND status IN ('ACTIVE', 'DISBURSED', 'DEFAULTED')
            ORDER BY "disbursedAt" ASC NULLS LAST, "createdAt" ASC
            LIMIT 1
            FOR UPDATE
          `;

    const loan = rows[0];
    if (!loan) {
      throw new NotFoundException('Target loan not found for repayment');
    }
    const repayableStatuses: LoanStatus[] = [
      LoanStatus.ACTIVE,
      LoanStatus.DISBURSED,
      LoanStatus.DEFAULTED,
    ];
    if (!repayableStatuses.includes(loan.status as LoanStatus)) {
      throw new BadRequestException(`Loan is not repayable in status ${loan.status}`);
    }
    return loan;
  }

  private async lockFosaAccount(
    tx: Prisma.TransactionClient,
    tenantId: string,
    memberId: string,
  ): Promise<LockedAccountRow> {
    const rows = await tx.$queryRaw<LockedAccountRow[]>`
      SELECT id, balance
      FROM "Account"
      WHERE "tenantId" = ${tenantId}
        AND "memberId" = ${memberId}
        AND "accountType" = ${AccountType.FOSA}::"AccountType"
        AND "isActive" = true
      LIMIT 1
      FOR UPDATE
    `;
    const account = rows[0];
    if (!account) {
      throw new NotFoundException('Active FOSA account not found for repayment');
    }
    return account;
  }

  private async applyInstallmentAllocation(
    tx: Prisma.TransactionClient,
    tenantId: string,
    loanId: string,
    allocation: { penalty: Decimal; interest: Decimal; principal: Decimal },
  ): Promise<void> {
    const rows = await tx.loanRepayment.findMany({
      where: { tenantId, loanId, status: { in: ['PENDING', 'PARTIAL'] } },
      orderBy: [{ dueDate: 'asc' }, { dayNumber: 'asc' }],
    });

    let penalty = allocation.penalty;
    let interest = allocation.interest;
    let principal = allocation.principal;
    const paidAt = new Date();

    for (const row of rows) {
      if (penalty.plus(interest).plus(principal).lessThanOrEqualTo(0)) {
        break;
      }

      const penaltyDue = new Decimal(row.penaltyDue.toString());
      const interestDue = new Decimal(row.interestDue.toString());
      const principalDue = new Decimal(row.principalDue.toString()).greaterThan(0)
        ? new Decimal(row.principalDue.toString())
        : new Decimal(row.amountPaid.toString());
      const penaltyPaid = new Decimal(row.penaltyPaid.toString());
      const interestPaid = new Decimal(row.interestPaid.toString());
      const principalPaid = new Decimal(row.principalPaid.toString());

      const addPenalty = Decimal.min(
        penalty,
        Decimal.max(penaltyDue.minus(penaltyPaid), new Decimal(0)),
      ).toDecimalPlaces(4);
      penalty = penalty.minus(addPenalty).toDecimalPlaces(4);
      const addInterest = Decimal.min(
        interest,
        Decimal.max(interestDue.minus(interestPaid), new Decimal(0)),
      ).toDecimalPlaces(4);
      interest = interest.minus(addInterest).toDecimalPlaces(4);
      const addPrincipal = Decimal.min(
        principal,
        Decimal.max(principalDue.minus(principalPaid), new Decimal(0)),
      ).toDecimalPlaces(4);
      principal = principal.minus(addPrincipal).toDecimalPlaces(4);

      if (addPenalty.plus(addInterest).plus(addPrincipal).lessThanOrEqualTo(0)) {
        continue;
      }

      const nextPenaltyPaid = penaltyPaid.plus(addPenalty).toDecimalPlaces(4);
      const nextInterestPaid = interestPaid.plus(addInterest).toDecimalPlaces(4);
      const nextPrincipalPaid = principalPaid.plus(addPrincipal).toDecimalPlaces(4);
      const paidTotal = nextPenaltyPaid.plus(nextInterestPaid).plus(nextPrincipalPaid);
      const dueTotal = penaltyDue.plus(interestDue).plus(principalDue);
      const status = paidTotal.greaterThanOrEqualTo(dueTotal) ? 'PAID' : 'PARTIAL';

      await tx.loanRepayment.update({
        where: { id: row.id },
        data: {
          penaltyPaid: nextPenaltyPaid.toString(),
          interestPaid: nextInterestPaid.toString(),
          principalPaid: nextPrincipalPaid.toString(),
          status,
          paidAt: status === 'PAID' ? paidAt : null,
          method: 'WATERFALL',
        },
      });
    }
  }

  private async createAllocationTransaction(
    tx: Prisma.TransactionClient,
    input: ProcessRepaymentInput,
    accountId: string,
    loanId: string,
    amount: Decimal,
    balance: Decimal,
    type: keyof typeof TransactionType,
    label: string,
  ): Promise<string> {
    const suffix = label.toUpperCase().replace(/\s+/g, '_');
    const transaction = await tx.transaction.create({
      data: {
        tenantId: input.tenantId,
        accountId,
        loanId,
        type: TransactionType[type],
        status: TransactionStatus.COMPLETED,
        amount: amount.toDecimalPlaces(4).toString(),
        balanceBefore: balance.toDecimalPlaces(4).toString(),
        balanceAfter: balance.toDecimalPlaces(4).toString(),
        reference: `${input.reference}-${suffix}-${uuidv4()}`,
        description: `${label} from repayment ${input.receipt ?? input.reference}`,
        processedBy: input.processedBy,
      },
    });
    return transaction.id;
  }
}
