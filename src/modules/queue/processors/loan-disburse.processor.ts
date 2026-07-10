import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, LoanDisburseJobPayload } from '../queue.constants';
import { LoansService } from '../../loans/loans.service';

/**
 * @deprecated DEAD QUEUE (Phase 3 audit, Issue #3b) — QUEUE_NAMES.LOAN_DISBURSE
 * is registered (BullModule.registerQueue) and monitored by the health/
 * admin-health dashboards and bull-board, but nothing in the codebase ever
 * calls `.add()` on it. There is no producer. It was superseded by the
 * synchronous disbursement flow (LoansController → LoansService.disburse()
 * directly, no queue).
 *
 * Kept registered rather than deleted: the health-check, admin-health, and
 * bull-board modules all reference QUEUE_NAMES.LOAN_DISBURSE directly, and
 * removing it would cascade into those unrelated modules for zero behavioral
 * gain (an empty, unused queue is exactly what those dashboards report today
 * either way). Instead this process() throws immediately — if anything ever
 * DOES get wired up to enqueue a job here again, it fails loudly and
 * repeatedly (BullMQ retries, then DLQs) instead of silently executing a
 * disbursement path that has had zero real-world traffic and predates the
 * Phase 1–2 ledger/idempotency/locking hardening.
 *
 * Do not remove this guard to "fix" a failing job without first confirming
 * a real producer was intentionally added and reviewed for the current
 * ledger/locking architecture.
 */
@Processor(QUEUE_NAMES.LOAN_DISBURSE, {
  concurrency: 2, // Low concurrency — money movements must serialize
})
export class LoanDisburseProcessor extends WorkerHost {
  private readonly logger = new Logger(LoanDisburseProcessor.name);

  constructor(private readonly loansService: LoansService) {
    super();
  }

  async process(_job: Job<LoanDisburseJobPayload>): Promise<void> {
    throw new Error(
      'DISABLED: LoanDisburseProcessor (QUEUE_NAMES.LOAN_DISBURSE) is dead code with no ' +
        'producer — see the @deprecated class doc. If you intentionally added a producer, ' +
        'this guard must be removed deliberately, not bypassed.',
    );
  }
}
