import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { QUEUE_NAMES, MpesaDisbursementJobPayload } from '../../queue/queue.constants';
import { MpesaService } from '../mpesa.service';

/**
 * Processes B2C loan disbursement jobs.
 *
 * This processor is responsible for making the Daraja B2C API call.
 * The actual ledger update happens later when Safaricom posts the B2C result
 * to the callback URL (handled by MpesaCallbackProcessor).
 *
 * Retry strategy: 3 attempts with exponential backoff (10s, 20s, 40s).
 * This is intentionally slower than callback processing because B2C calls
 * are high-value and we want to avoid hammering Daraja on transient errors.
 *
 * DLQ: after 3 failures the job is moved to MPESA_DISBURSEMENT_DLQ where
 * it sits for manual review. The SACCO officer must requeue or manually
 * disburse via the Safaricom portal.
 *
 * Idempotency: the jobId is `b2c-disburse-{loanId}` so re-approving the
 * same loan produces the same job and is deduplicated by BullMQ. Inside
 * executeB2cDisbursement() we additionally check for an existing PENDING
 * or COMPLETED MpesaTransaction for the same loanId.
 */
@Processor(QUEUE_NAMES.MPESA_DISBURSEMENT, { concurrency: 2 })
export class MpesaDisbursementProcessor extends WorkerHost {
  private readonly logger = new Logger(MpesaDisbursementProcessor.name);

  constructor(
    private readonly mpesaService: MpesaService,
    @InjectQueue(QUEUE_NAMES.MPESA_DISBURSEMENT_DLQ)
    private readonly dlq: Queue,
  ) {
    super();
  }

  async process(job: Job<MpesaDisbursementJobPayload>): Promise<void> {
    const { loanId, tenantId, phone, amount, triggeredBy } = job.data;
    this.logger.log(`B2C disbursement job | job=${job.id} loan=${loanId} tenant=${tenantId}`);

    const result = await this.mpesaService.executeB2cDisbursement(
      loanId,
      tenantId,
      phone,
      amount,
      triggeredBy,
    );

    this.logger.log(
      `B2C initiated | loan=${loanId} conversation=${result.conversationId} mpesaTx=${result.mpesaTxId}`,
    );
  }

  /** Move exhausted jobs to the dead-letter queue for manual review */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<MpesaDisbursementJobPayload>): Promise<void> {
    if ((job.attemptsMade ?? 0) < (job.opts?.attempts ?? 3)) return;

    this.logger.error(
      `B2C disbursement job ${job.id} failed after ${job.attemptsMade} attempts – moved to DLQ`,
      job.failedReason,
    );

    await this.dlq.add(
      'dead-letter',
      {
        originalJobId: job.id,
        ...job.data,
        failedReason: job.failedReason,
        failedAt: new Date().toISOString(),
      },
      { removeOnFail: false, removeOnComplete: false },
    );
  }
}
