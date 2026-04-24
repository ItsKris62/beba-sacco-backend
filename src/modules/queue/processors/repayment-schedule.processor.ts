import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Decimal } from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { TransactionType, TransactionStatus } from '@prisma/client';
import { QUEUE_NAMES, RepaymentScheduleJobPayload } from '../queue.constants';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Processes a scheduled loan repayment instalment.
 *
 * This job is enqueued (delayed) at disbursement time for each monthly
 * instalment. When it fires:
 *   1. Check if the loan is still ACTIVE
 *   2. Auto-debit from FOSA account
 *   3. If insufficient funds, log a warning and let the accrual job handle penalty
 *   4. Post LOAN_REPAYMENT transaction and decrement outstandingBalance
 */
@Processor(QUEUE_NAMES.REPAYMENT_SCHEDULE, { concurrency: 5 })
export class RepaymentScheduleProcessor extends WorkerHost {
  private readonly logger = new Logger(RepaymentScheduleProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<RepaymentScheduleJobPayload>) {
    const { loanId, tenantId, instalmentAmount, dueDate } = job.data;

    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId },
      include: {
        member: {
          include: {
            accounts: { where: { accountType: 'FOSA', isActive: true }, take: 1 },
          },
        },
      },
    });

    if (!loan) {
      this.logger.warn(`Repayment job: loan ${loanId} not found`);
      return;
    }

    if (!['ACTIVE', 'DISBURSED'].includes(loan.status)) {
      this.logger.log(`Repayment job: loan ${loanId} status=${loan.status} – skipping`);
      return;
    }

    const fosaAccount = loan.member.accounts[0];
    if (!fosaAccount) {
      this.logger.warn(`Repayment job: no FOSA account for loan ${loanId}`);
      return;
    }

    const instalment = new Decimal(instalmentAmount);
    const balance = new Decimal(fosaAccount.balance.toString());

    if (balance.lt(instalment)) {
      this.logger.warn(
        `Repayment job: insufficient FOSA funds for loan=${loanId} required=${instalment.toNumber()} balance=${balance.toNumber()}`,
      );
      // Grace: leave for accrual/penalty to handle – do not attempt partial payment
      return;
    }

    const outstanding = new Decimal(loan.outstandingBalance.toString());
    const actualRepayment = instalment.gt(outstanding) ? outstanding : instalment;
    const newBalance = balance.minus(actualRepayment);
    const newOutstanding = outstanding.minus(actualRepayment);

    await this.prisma.$transaction(async (tx) => {
      const reference = `SCHED-REPAY-${loanId}-${dueDate}-${uuidv4().split('-')[0]}`;

      // Idempotency: skip if already posted
      const existing = await tx.transaction.findUnique({ where: { reference } });
      if (existing) return;

      await tx.transaction.create({
        data: {
          tenantId,
          accountId: fosaAccount.id,
          loanId,
          type: TransactionType.LOAN_REPAYMENT,
          status: TransactionStatus.COMPLETED,
          amount: actualRepayment.toDecimalPlaces(4).toString(),
          balanceBefore: balance.toDecimalPlaces(4).toString(),
          balanceAfter: newBalance.toDecimalPlaces(4).toString(),
          reference,
          description: `Scheduled instalment – due ${dueDate}`,
          processedBy: 'SYSTEM',
        },
      });

      await tx.account.update({
        where: { id: fosaAccount.id },
        data: { balance: newBalance.toDecimalPlaces(4).toString() },
      });

      await tx.loan.update({
        where: { id: loanId },
        data: {
          totalRepaid: new Decimal(loan.totalRepaid.toString()).plus(actualRepayment).toDecimalPlaces(4).toString(),
          outstandingBalance: newOutstanding.toDecimalPlaces(4).toString(),
          ...(newOutstanding.lte(0) && { status: 'FULLY_PAID' }),
        },
      });
    });

    this.logger.log(`Repayment scheduled: loan=${loanId} amount=${actualRepayment.toNumber()} due=${dueDate}`);
  }
}
