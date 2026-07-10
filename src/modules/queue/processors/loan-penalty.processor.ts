import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InstallmentStatus, Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { toDecimal } from '../../../common/utils/decimal.util';
import { AuditService as AuditLogService } from '../../audit/audit.service';
import { LedgerService } from '../../accounting/ledger.service';
import { APPLY_DAILY_PENALTIES_JOB, QUEUE_NAMES } from '../queue.constants';

@Processor(QUEUE_NAMES.LOAN_PENALTY_QUEUE, { concurrency: 2 })
export class LoanPenaltyProcessor extends WorkerHost {
  private readonly logger = new Logger(LoanPenaltyProcessor.name);
  private readonly penaltyRate = toDecimal('0.01')!;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly ledger: LedgerService,
  ) {
    super();
  }

  async process(job: Job): Promise<{ processed: number; skipped: number; totalPenalty: string }> {
    if (job.name !== APPLY_DAILY_PENALTIES_JOB) {
      this.logger.warn(`Ignoring unsupported job ${job.name}`);
      return { processed: 0, skipped: 0, totalPenalty: '0.0000' };
    }

    const today = this.startOfDay(new Date());
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - 3);

    const overdue = await this.prisma.loanRepayment.findMany({
      where: {
        status: InstallmentStatus.PENDING,
        dueDate: { lt: cutoff },
        OR: [{ lastPenaltyAccrualDate: null }, { lastPenaltyAccrualDate: { lt: today } }],
        loan: { status: { in: ['ACTIVE', 'DISBURSED', 'DEFAULTED'] } },
      },
      select: { id: true, loanId: true, tenantId: true },
      orderBy: [{ loanId: 'asc' }, { dueDate: 'asc' }],
      take: 1000,
    });

    let processed = 0;
    let skipped = 0;
    let totalPenalty = toDecimal(0)!;

    for (const row of overdue) {
      const result = await this.applyPenalty(row.id, row.loanId, row.tenantId, today, job.id?.toString());
      if (result.applied) {
        processed++;
        totalPenalty = totalPenalty.plus(result.penalty);
      } else {
        skipped++;
      }
    }

    const loanCount = new Set(overdue.map((row) => row.loanId)).size;
    this.logger.log(`Applied penalties to ${processed} installment(s) across ${loanCount} loan(s)`);
    return { processed, skipped, totalPenalty: totalPenalty.toDecimalPlaces(4).toString() };
  }

  private async applyPenalty(
    installmentId: string,
    loanId: string,
    tenantId: string,
    accrualDate: Date,
    jobId?: string,
  ): Promise<{ applied: boolean; penalty: Prisma.Decimal }> {
    return this.prisma.$transaction(async (tx) => {
      const installment = await tx.loanRepayment.findFirst({
        where: {
          id: installmentId,
          tenantId,
          loanId,
          status: InstallmentStatus.PENDING,
          OR: [{ lastPenaltyAccrualDate: null }, { lastPenaltyAccrualDate: { lt: accrualDate } }],
        },
        include: {
          loan: {
            select: {
              id: true,
              loanNumber: true,
              tenantId: true,
              memberId: true,
              outstandingBalance: true,
              arrearsAmount: true,
              updatedAt: true,
              member: {
                select: {
                  accounts: {
                    where: { accountType: 'FOSA', isActive: true },
                    select: { id: true, balance: true },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      });

      if (!installment || installment.loan.tenantId !== tenantId) {
        return { applied: false, penalty: toDecimal(0)! };
      }

      const principalDue = toDecimal(installment.principalDue)!;
      const interestDue = toDecimal(installment.interestDue)!;
      const penalty = principalDue.plus(interestDue).times(this.penaltyRate).toDecimalPlaces(4);
      if (penalty.lessThanOrEqualTo(0)) {
        return { applied: false, penalty: toDecimal(0)! };
      }

      const account = installment.loan.member.accounts[0];
      if (!account) {
        this.logger.warn(`Skipping penalty for loan=${loanId}; no active FOSA account found`);
        return { applied: false, penalty: toDecimal(0)! };
      }

      const repaymentUpdate = await tx.loanRepayment.updateMany({
        where: {
          id: installment.id,
          tenantId,
          status: InstallmentStatus.PENDING,
          OR: [{ lastPenaltyAccrualDate: null }, { lastPenaltyAccrualDate: { lt: accrualDate } }],
        },
        data: {
          penaltyDue: { increment: penalty.toString() },
          lastPenaltyAccrualDate: accrualDate,
          status: InstallmentStatus.OVERDUE,
        },
      });

      if (repaymentUpdate.count !== 1) {
        return { applied: false, penalty: toDecimal(0)! };
      }

      const loanUpdate = await tx.loan.updateMany({
        where: { id: loanId, tenantId, updatedAt: installment.loan.updatedAt },
        data: {
          arrearsAmount: { increment: penalty.toString() },
          outstandingBalance: { increment: penalty.toString() },
        },
      });

      if (loanUpdate.count !== 1) {
        throw new Error(`Loan OCC update failed for ${loanId}`);
      }

      const balance = toDecimal(account.balance)!;
      // Deterministic — includes installment.id (not just loanId+date) because a
      // single loan can have more than one overdue installment on the same day;
      // collapsing to PENALTY-{tenantId}-{loanId}-{YYYYMMDD} alone would silently
      // drop every installment's penalty after the first on a given day.
      const accrualDateStr = accrualDate.toISOString().slice(0, 10);
      const reference = `PENALTY-${tenantId}-${loanId}-${installment.id}-${accrualDateStr}`;
      const penaltyTxn = await tx.transaction.create({
        data: {
          tenantId,
          accountId: account.id,
          loanId,
          type: TransactionType.PENALTY,
          status: TransactionStatus.COMPLETED,
          amount: penalty.toString(),
          balanceBefore: balance.toString(),
          balanceAfter: balance.toString(),
          reference,
          description: `Daily overdue installment penalty for loan ${installment.loan.loanNumber}`,
          processedBy: 'SYSTEM',
        },
      });

      // GL leg posted in the SAME transaction as the Transaction row above — no
      // more window where the operational record exists but the GL doesn't. No
      // Account.balance changes here (this installment's penalty isn't collected
      // yet, only recognized as owed) — see LedgerService.postPenaltyReceivableEntry().
      await this.ledger.postPenaltyReceivableEntry({
        tx,
        tenantId,
        reference,
        amount: penalty,
        transactionId: penaltyTxn.id,
        description: `Daily overdue installment penalty for loan ${installment.loan.loanNumber}`,
      });

      await this.auditLog.createAtomic(tx, {
        tenantId,
        actorId: 'SYSTEM',
        action: 'LOAN.PENALTY.APPLIED',
        entityType: 'LoanRepayment',
        entityId: installment.id,
        oldValue: { status: InstallmentStatus.PENDING, penaltyDue: installment.penaltyDue.toString() },
        newValue: { status: InstallmentStatus.OVERDUE, penaltyDueIncrement: penalty.toString() },
        metadata: {
          jobId,
          loanId,
          loanNumber: installment.loan.loanNumber,
          principalDue: principalDue.toString(),
          interestDue: interestDue.toString(),
          penalty: penalty.toString(),
          accrualDate: accrualDate.toISOString(),
        },
      });

      return { applied: true, penalty };
    });
  }

  private startOfDay(date: Date): Date {
    const next = new Date(date);
    next.setHours(0, 0, 0, 0);
    return next;
  }
}
