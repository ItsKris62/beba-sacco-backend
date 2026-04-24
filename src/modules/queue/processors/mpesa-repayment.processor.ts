import { Logger } from '@nestjs/common';
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { MpesaService } from '../../mpesa/mpesa.service';
import { maskPhone } from '../../mpesa/utils/mpesa.utils';
import { QUEUE_NAMES } from '../queue.constants';
import { StkRepaymentJobPayload } from './mpesa-repayment.scheduler';

/**
 * MpesaRepaymentProcessor
 *
 * Consumes jobs from MPESA_STK_REPAYMENT queue (enqueued by MpesaRepaymentScheduler).
 * Each job represents one scheduled loan repayment STK Push.
 *
 * Separation of concerns:
 *  - This queue is ONLY for scheduler-initiated STK initiations.
 *  - MpesaCallbackProcessor handles incoming Daraja callbacks (different shape).
 *  - Mixing them in one queue would require isStkCallback() shape guards that
 *    StkRepaymentJobPayload would never pass, silently discarding the jobs.
 *
 * On failure:
 *  - attempts: 1 (set by scheduler) — job is logged and not retried.
 *  - The next day's cron creates a fresh stk-repay-{loanId}-{YYYYMMDD+1} job.
 *  - This prevents DLQ accumulation of stale multi-day repayment retries.
 *  - removeOnFail: false — jobs remain in failed state for Bull Board inspection.
 */
@Processor(QUEUE_NAMES.MPESA_STK_REPAYMENT, { concurrency: 3 })
export class MpesaRepaymentProcessor extends WorkerHost {
  private readonly logger = new Logger(MpesaRepaymentProcessor.name);

  constructor(private readonly mpesaService: MpesaService) {
    super();
  }

  async process(job: Job<StkRepaymentJobPayload>): Promise<void> {
    const { loanId, memberId, tenantId, phone, amount, accountReference, triggerSource } =
      job.data;

    this.logger.log(
      `Processing scheduled STK repayment | jobId=${job.id} loan=${loanId} ` +
        `phone=${maskPhone(phone)} amount=${amount} ref=${accountReference}`,
    );

    await this.mpesaService.initiateScheduledStkPush({
      loanId,
      memberId,
      tenantId,
      phone,
      amount,
      accountReference,
      triggerSource,
    });
  }

  // ─── Failure handler ─────────────────────────────────────────────────────

  @OnWorkerEvent('failed')
  onFailed(job: Job<StkRepaymentJobPayload>): void {
    const { loanId, phone } = job.data;
    // Log and let the job remain in failed state (Bull Board will surface it).
    // No DLQ move — the scheduler creates a fresh job tomorrow.
    // SASRA: failure is logged with loan reference for audit trail.
    this.logger.error(
      `Scheduled STK repayment failed | jobId=${job.id} loan=${loanId} ` +
        `phone=${maskPhone(phone)} reason=${job.failedReason ?? 'unknown'} ` +
        `attempts=${job.attemptsMade}`,
    );
  }
}
