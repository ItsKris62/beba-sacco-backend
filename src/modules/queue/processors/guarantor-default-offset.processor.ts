import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { AccountType, GuarantorStatus, LoanStaging, LoanStatus, Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { toDecimal } from '../../../common/utils/decimal.util';
import { AuditService as AuditLogService } from '../../audit/audit.service';
import { PROCESS_GUARANTOR_FORFEITURE_JOB, QUEUE_NAMES } from '../queue.constants';

@Processor(QUEUE_NAMES.GUARANTOR_DEFAULT_OFFSET_QUEUE, { concurrency: 1 })
export class GuarantorDefaultOffsetProcessor extends WorkerHost {
  private readonly logger = new Logger(GuarantorDefaultOffsetProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super();
  }

  async process(job: Job): Promise<{ processedLoans: number; totalForfeited: string }> {
    if (job.name !== PROCESS_GUARANTOR_FORFEITURE_JOB) {
      this.logger.warn(`Ignoring unsupported job ${job.name}`);
      return { processedLoans: 0, totalForfeited: '0.0000' };
    }

    const loans = await this.prisma.loan.findMany({
      where: {
        status: { notIn: [LoanStatus.FULLY_PAID, LoanStatus.WRITTEN_OFF] },
        OR: [{ staging: LoanStaging.NPL }, { arrearsDays: { gt: 90 } }],
        guarantors: { some: { status: GuarantorStatus.ACCEPTED, holdReleasedAt: null } },
      },
      select: { id: true, tenantId: true },
      orderBy: { updatedAt: 'asc' },
      take: 250,
    });

    let processedLoans = 0;
    let totalForfeited = toDecimal(0)!;

    for (const loan of loans) {
      const result = await this.offsetLoan(loan.id, loan.tenantId, job.id?.toString());
      if (result.forfeited.greaterThan(0)) {
        processedLoans++;
        totalForfeited = totalForfeited.plus(result.forfeited);
      }
    }

    this.logger.log(`Processed guarantor forfeiture for ${processedLoans} loan(s)`);
    return { processedLoans, totalForfeited: totalForfeited.toDecimalPlaces(4).toString() };
  }

  private async offsetLoan(
    loanId: string,
    tenantId: string,
    jobId?: string,
  ): Promise<{ forfeited: Prisma.Decimal }> {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: {
          id: loanId,
          tenantId,
          status: { notIn: [LoanStatus.FULLY_PAID, LoanStatus.WRITTEN_OFF] },
          OR: [{ staging: LoanStaging.NPL }, { arrearsDays: { gt: 90 } }],
        },
        select: {
          id: true,
          loanNumber: true,
          tenantId: true,
          outstandingBalance: true,
          status: true,
          staging: true,
          arrearsDays: true,
          updatedAt: true,
          guarantors: {
            where: { tenantId, status: GuarantorStatus.ACCEPTED, holdReleasedAt: null },
            select: { id: true, memberId: true, guaranteedAmount: true, recoveredAmount: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!loan || loan.guarantors.length === 0) {
        return { forfeited: toDecimal(0)! };
      }

      let totalForfeited = toDecimal(0)!;
      const forfeitedAt = new Date();

      for (const guarantor of loan.guarantors) {
        const account = await tx.account.findFirst({
          where: { tenantId, memberId: guarantor.memberId, accountType: AccountType.BOSA, isActive: true },
          select: { id: true, balance: true, frozenSavings: true, version: true },
        });

        if (!account) {
          this.logger.warn(`Skipping guarantor=${guarantor.memberId}; no active BOSA account`);
          continue;
        }

        const guaranteed = toDecimal(guarantor.guaranteedAmount)!;
        const alreadyRecovered = toDecimal(guarantor.recoveredAmount)!;
        const remainingGuarantee = Prisma.Decimal.max(guaranteed.minus(alreadyRecovered), toDecimal(0)!);
        const balance = toDecimal(account.balance)!;
        const frozenSavings = toDecimal(account.frozenSavings)!;
        const amount = Prisma.Decimal.min(remainingGuarantee, balance, frozenSavings).toDecimalPlaces(4);

        if (amount.lessThanOrEqualTo(0)) {
          continue;
        }

        const balanceAfter = balance.minus(amount).toDecimalPlaces(4);
        const frozenAfter = frozenSavings.minus(amount).toDecimalPlaces(4);
        const accountUpdate = await tx.account.updateMany({
          where: {
            id: account.id,
            tenantId,
            version: account.version,
            balance: account.balance,
            frozenSavings: account.frozenSavings,
          },
          data: {
            balance: balanceAfter.toString(),
            frozenSavings: frozenAfter.toString(),
            version: { increment: 1 },
          },
        });

        if (accountUpdate.count !== 1) {
          throw new Error(`Account OCC update failed for guarantor ${guarantor.memberId}`);
        }

        await tx.loanGuarantor.updateMany({
          where: { id: guarantor.id, tenantId, status: GuarantorStatus.ACCEPTED, holdReleasedAt: null },
          data: {
            recoveredAmount: { increment: amount.toString() },
            recoveryDate: forfeitedAt,
            holdReleasedAt: forfeitedAt,
          },
        });

        await tx.transaction.create({
          data: {
            tenantId,
            accountId: account.id,
            loanId,
            type: TransactionType.WITHDRAWAL,
            status: TransactionStatus.COMPLETED,
            amount: amount.toString(),
            balanceBefore: balance.toString(),
            balanceAfter: balanceAfter.toString(),
            reference: `GUARANTOR-FORFEIT-${guarantor.id}-${forfeitedAt.getTime()}`,
            description: `Guarantor default offset for loan ${loan.loanNumber}`,
            processedBy: 'SYSTEM',
          },
        });

        await this.auditLog.createAtomic(tx, {
          tenantId,
          actorId: 'SYSTEM',
          action: 'GUARANTOR.DEFAULT_OFFSET.FORFEITED',
          entityType: 'LoanGuarantor',
          entityId: guarantor.id,
          oldValue: {
            accountBalance: balance.toString(),
            frozenSavings: frozenSavings.toString(),
            recoveredAmount: alreadyRecovered.toString(),
          },
          newValue: {
            accountBalance: balanceAfter.toString(),
            frozenSavings: frozenAfter.toString(),
            recoveredAmountIncrement: amount.toString(),
          },
          metadata: { jobId, loanId, loanNumber: loan.loanNumber, guarantorMemberId: guarantor.memberId },
        });

        totalForfeited = totalForfeited.plus(amount).toDecimalPlaces(4);
      }

      if (totalForfeited.lessThanOrEqualTo(0)) {
        return { forfeited: toDecimal(0)! };
      }

      const outstandingBefore = toDecimal(loan.outstandingBalance)!;
      const outstandingDeduction = Prisma.Decimal.min(outstandingBefore, totalForfeited).toDecimalPlaces(4);
      const outstandingAfter = outstandingBefore.minus(outstandingDeduction).toDecimalPlaces(4);
      const nextStatus = outstandingAfter.lessThanOrEqualTo(0) ? LoanStatus.FULLY_PAID : LoanStatus.WRITTEN_OFF;
      const loanUpdate = await tx.loan.updateMany({
        where: { id: loan.id, tenantId, updatedAt: loan.updatedAt },
        data: {
          outstandingBalance: outstandingAfter.lessThanOrEqualTo(0) ? '0' : outstandingAfter.toString(),
          status: nextStatus,
          staging: nextStatus === LoanStatus.FULLY_PAID ? LoanStaging.PERFORMING : LoanStaging.NPL,
          arrearsAmount: outstandingAfter.lessThanOrEqualTo(0) ? '0' : undefined,
        },
      });

      if (loanUpdate.count !== 1) {
        throw new Error(`Loan OCC update failed for ${loan.id}`);
      }

      await this.auditLog.createAtomic(tx, {
        tenantId,
        actorId: 'SYSTEM',
        action: 'LOAN.DEFAULT_OFFSET.APPLIED',
        entityType: 'Loan',
        entityId: loan.id,
        oldValue: {
          status: loan.status,
          staging: loan.staging,
          outstandingBalance: outstandingBefore.toString(),
        },
        newValue: {
          status: nextStatus,
          outstandingBalance: outstandingAfter.lessThanOrEqualTo(0) ? '0' : outstandingAfter.toString(),
        },
        metadata: {
          jobId,
          totalForfeited: totalForfeited.toString(),
          outstandingDeduction: outstandingDeduction.toString(),
          arrearsDays: loan.arrearsDays,
        },
      });

      return { forfeited: totalForfeited };
    });
  }
}
