import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, RepaymentScheduleJobPayload } from '../queue.constants';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * @deprecated DEAD/UNSAFE — DISABLED (Phase 3 audit, Issue #6c).
 *
 * QUEUE_NAMES.REPAYMENT_SCHEDULE is registered (BullModule.registerQueue) and
 * monitored by the admin-health dashboard, but nothing in the codebase ever
 * enqueues a job onto it — no producer exists. It predates
 * LoanRepaymentService (the live repayment path) and LedgerService, and its
 * original logic (see git history) was actively unsafe:
 *   - Wrote Transaction + Account.balance directly, completely bypassing
 *     LedgerService — no JournalEntry/GLPosting was ever created (exactly the
 *     class of bug findGlBypasses() / GL_BYPASS_DETECTED now scans for — see
 *     FinancialService.runLedgerIntegrityCheck()).
 *   - No FOR UPDATE row lock on the Account/Loan before reading balances,
 *     unlike LoansService.repay() and LoanRepaymentService.processRepayment()
 *     — a real TOCTOU double-debit risk under concurrent execution.
 *
 * Kept registered rather than deleted: admin-health.service.ts and
 * admin-health.module.ts reference QUEUE_NAMES.REPAYMENT_SCHEDULE directly
 * for dashboard monitoring, and removing the queue would cascade into that
 * unrelated module for zero behavioral gain. Instead this process() throws
 * immediately so a future producer accidentally wired up to this queue fails
 * loudly (BullMQ retries, then DLQs) instead of silently executing an unsafe,
 * unaudited path. Scheduled instalment auto-debit, if built for real, belongs
 * on LoanRepaymentService.processRepayment() (ledger-integrated,
 * lock-protected), not a rewrite of this file.
 *
 * Do not remove this guard without rebuilding the logic on top of
 * LoanRepaymentService / LedgerService first.
 */
@Processor(QUEUE_NAMES.REPAYMENT_SCHEDULE, { concurrency: 5 })
export class RepaymentScheduleProcessor extends WorkerHost {
  private readonly logger = new Logger(RepaymentScheduleProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(_job: Job<RepaymentScheduleJobPayload>) {
    throw new Error(
      'DISABLED: RepaymentScheduleProcessor (QUEUE_NAMES.REPAYMENT_SCHEDULE) is dead code ' +
        'with no producer, and its original GL-bypassing/unlocked balance logic was unsafe — ' +
        'see the @deprecated class doc. Rebuild on LoanRepaymentService/LedgerService before re-enabling.',
    );
  }
}
