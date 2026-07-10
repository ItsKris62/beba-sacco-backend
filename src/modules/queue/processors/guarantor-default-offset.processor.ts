import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  AccountType,
  GuarantorStatus,
  LoanStaging,
  LoanStatus,
  Prisma,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../common/services/redis.service';
import { toDecimal } from '../../../common/utils/decimal.util';
import { AuditService as AuditLogService } from '../../audit/audit.service';
import { LedgerService } from '../../accounting/ledger.service';
import {
  EmailJobPayload,
  GUARANTOR_FORFEITURE_LOCK_TTL_SECONDS,
  PROCESS_GUARANTOR_FORFEITURE_JOB,
  QUEUE_NAMES,
  SmsJobPayload,
  guarantorForfeitureReference,
  guarantorForfeitureLockKey,
} from '../queue.constants';

interface ForfeitureNotification {
  guarantorMemberId: string;
  loanId: string;
  loanNumber: string;
  amountForfeited: Prisma.Decimal;
  remainingGuarantee: Prisma.Decimal;
  phone: string | null;
  email: string | null;
  firstName: string;
}

@Processor(QUEUE_NAMES.GUARANTOR_DEFAULT_OFFSET_QUEUE, { concurrency: 1 })
export class GuarantorDefaultOffsetProcessor extends WorkerHost {
  private readonly logger = new Logger(GuarantorDefaultOffsetProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly redis: RedisService,
    private readonly ledger: LedgerService,
    @InjectQueue(QUEUE_NAMES.SMS)
    private readonly smsQueue: Queue<SmsJobPayload>,
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue<EmailJobPayload>,
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
      // Notifications are dispatched only after the forfeiture transaction has
      // committed. A notification failure must never roll back — or even mark
      // as failed — a financial transaction that has already been applied.
      for (const notification of result.notifications) {
        await this.notifyGuarantor(notification);
      }
    }

    this.logger.log(`Processed guarantor forfeiture for ${processedLoans} loan(s)`);
    return { processedLoans, totalForfeited: totalForfeited.toDecimalPlaces(4).toString() };
  }

  private async notifyGuarantor(notification: ForfeitureNotification): Promise<void> {
    const amount = notification.amountForfeited.toFixed(2);
    const remaining = notification.remainingGuarantee.toFixed(2);
    const message =
      `Beba SACCO: Automatic guarantor forfeiture - KES ${amount} has been deducted from your savings to cover ` +
      `the default on loan ${notification.loanNumber} you guaranteed. Remaining guarantee balance: KES ${remaining}. ` +
      `Contact support if you have questions.`;

    try {
      if (notification.phone) {
        await this.smsQueue.add(
          'send',
          { type: 'GUARANTOR_RECOVERY_DEBITED', phone: notification.phone, message },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        );
      }
      if (notification.email) {
        await this.emailQueue.add(
          'send',
          {
            type: 'SYSTEM_NOTICE',
            to: notification.email,
            firstName: notification.firstName,
            subject: `Guarantor forfeiture applied for loan ${notification.loanNumber}`,
            body: message,
          },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        );
      }
    } catch (err: unknown) {
      // The debit already committed in offsetLoan()'s transaction — a failure
      // here must be logged, not thrown, so it can never fail this BullMQ job
      // or trigger a retry of an already-applied financial transaction.
      this.logger.error(
        `Failed to notify guarantor=${notification.guarantorMemberId} of default offset on loan=${notification.loanId}`,
        err,
      );
    }
  }

  private async offsetLoan(
    loanId: string,
    tenantId: string,
    jobId?: string,
  ): Promise<{ forfeited: Prisma.Decimal; notifications: ForfeitureNotification[] }> {
    // Distributed lock: LoanRecoveryService.recoverFromGuarantors() (the delayed
    // post-notice debit path) can target the exact same loan's guarantors. Without
    // this, a cron pass and a delayed-debit job racing each other would both read
    // the same pre-forfeiture balance and both deduct — a double-debit of the
    // guarantor's savings. Skip (not throw) on contention: this loop processes up
    // to 250 loans per run, and one locked loan must not abort the rest of the
    // batch. It will simply be picked up on the next cron pass.
    const lockKey = guarantorForfeitureLockKey(tenantId, loanId);
    const lockToken = await this.redis.acquireLock(lockKey, GUARANTOR_FORFEITURE_LOCK_TTL_SECONDS);
    if (!lockToken) {
      this.logger.warn(
        `Guarantor forfeiture lock held for tenant=${tenantId} loan=${loanId} — skipping this pass`,
      );
      return { forfeited: toDecimal(0)!, notifications: [] };
    }

    try {
      return await this.offsetLoanLocked(loanId, tenantId, jobId);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken);
    }
  }

  private async offsetLoanLocked(
    loanId: string,
    tenantId: string,
    jobId?: string,
  ): Promise<{ forfeited: Prisma.Decimal; notifications: ForfeitureNotification[] }> {
    const recoveryAttemptId = jobId ? `${jobId}-${randomUUID()}` : randomUUID();

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
            select: {
              id: true,
              memberId: true,
              guaranteedAmount: true,
              recoveredAmount: true,
              member: {
                select: {
                  user: {
                    select: { email: true, firstName: true, phone: true, phoneNumber: true },
                  },
                },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!loan || loan.guarantors.length === 0) {
        return { forfeited: toDecimal(0)!, notifications: [] };
      }

      let totalForfeited = toDecimal(0)!;
      const forfeitedAt = new Date();
      const notifications: ForfeitureNotification[] = [];

      for (const guarantor of loan.guarantors) {
        const account = await tx.account.findFirst({
          where: {
            tenantId,
            memberId: guarantor.memberId,
            accountType: AccountType.BOSA,
            isActive: true,
          },
          select: { id: true, balance: true, frozenSavings: true, version: true },
        });

        if (!account) {
          this.logger.warn(`Skipping guarantor=${guarantor.memberId}; no active BOSA account`);
          continue;
        }

        const guaranteed = toDecimal(guarantor.guaranteedAmount)!;
        const alreadyRecovered = toDecimal(guarantor.recoveredAmount)!;
        const remainingGuarantee = Prisma.Decimal.max(
          guaranteed.minus(alreadyRecovered),
          toDecimal(0)!,
        );
        const balance = toDecimal(account.balance)!;
        const frozenSavings = toDecimal(account.frozenSavings)!;
        const amount = Prisma.Decimal.min(
          remainingGuarantee,
          balance,
          frozenSavings,
        ).toDecimalPlaces(4);

        if (amount.lessThanOrEqualTo(0)) {
          continue;
        }

        // Shared format with LoanRecoveryService. The attempt suffix prevents one
        // partial forfeiture from blocking later recovery attempts.
        const reference = guarantorForfeitureReference(
          tenantId,
          loanId,
          account.id,
          recoveryAttemptId,
        );
        const existingForfeiture = await tx.transaction.findFirst({ where: { tenantId, reference } });
        if (existingForfeiture) {
          this.logger.warn(`Guarantor forfeiture already posted for reference=${reference} — skipping`);
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
          where: {
            id: guarantor.id,
            tenantId,
            status: GuarantorStatus.ACCEPTED,
            holdReleasedAt: null,
          },
          data: {
            recoveredAmount: { increment: amount.toString() },
            recoveryDate: forfeitedAt,
            holdReleasedAt: forfeitedAt,
          },
        });

        const forfeitureTxn = await tx.transaction.create({
          data: {
            tenantId,
            accountId: account.id,
            loanId,
            type: TransactionType.WITHDRAWAL,
            status: TransactionStatus.COMPLETED,
            amount: amount.toString(),
            balanceBefore: balance.toString(),
            balanceAfter: balanceAfter.toString(),
            reference,
            description: `Guarantor default offset for loan ${loan.loanNumber}`,
            processedBy: 'SYSTEM',
          },
        });

        // GL leg: debit the guarantor's own BOSA deposit-liability code, credit
        // LOAN_RECEIVABLE — the account.updateMany() above is the only balance
        // mutation; this call is GL-only (see LedgerService.postGuarantorForfeitureEntry
        // docs) so the two together can never double-debit.
        await this.ledger.postGuarantorForfeitureEntry({
          tx,
          tenantId,
          reference,
          amount,
          accountType: AccountType.BOSA,
          transactionId: forfeitureTxn.id,
          description: `Guarantor default offset for loan ${loan.loanNumber}`,
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
          metadata: {
            jobId,
            loanId,
            loanNumber: loan.loanNumber,
            guarantorMemberId: guarantor.memberId,
          },
        });

        totalForfeited = totalForfeited.plus(amount).toDecimalPlaces(4);
        notifications.push({
          guarantorMemberId: guarantor.memberId,
          loanId,
          loanNumber: loan.loanNumber,
          amountForfeited: amount,
          remainingGuarantee: remainingGuarantee.minus(amount),
          phone: guarantor.member.user.phone ?? guarantor.member.user.phoneNumber ?? null,
          email: guarantor.member.user.email ?? null,
          firstName: guarantor.member.user.firstName,
        });
      }

      if (totalForfeited.lessThanOrEqualTo(0)) {
        return { forfeited: toDecimal(0)!, notifications: [] };
      }

      const outstandingBefore = toDecimal(loan.outstandingBalance)!;
      const outstandingDeduction = Prisma.Decimal.min(
        outstandingBefore,
        totalForfeited,
      ).toDecimalPlaces(4);
      const outstandingAfter = outstandingBefore.minus(outstandingDeduction).toDecimalPlaces(4);
      const nextStatus = outstandingAfter.lessThanOrEqualTo(0)
        ? LoanStatus.FULLY_PAID
        : LoanStatus.WRITTEN_OFF;
      const loanUpdate = await tx.loan.updateMany({
        where: { id: loan.id, tenantId, updatedAt: loan.updatedAt },
        data: {
          outstandingBalance: outstandingAfter.lessThanOrEqualTo(0)
            ? '0'
            : outstandingAfter.toString(),
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
          outstandingBalance: outstandingAfter.lessThanOrEqualTo(0)
            ? '0'
            : outstandingAfter.toString(),
        },
        metadata: {
          jobId,
          totalForfeited: totalForfeited.toString(),
          outstandingDeduction: outstandingDeduction.toString(),
          arrearsDays: loan.arrearsDays,
        },
      });

      return { forfeited: totalForfeited, notifications };
    });
  }
}
