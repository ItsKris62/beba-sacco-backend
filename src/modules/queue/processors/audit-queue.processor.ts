import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { AuditChainService } from '../../audit/audit.chain.service';
import { AuditPersistJobPayload, QUEUE_NAMES } from '../queue.constants';

@Processor(QUEUE_NAMES.AUDIT_PERSIST, { concurrency: 8 })
export class AuditQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(AuditQueueProcessor.name);

  constructor(
    private readonly chain: AuditChainService,
    @InjectQueue(QUEUE_NAMES.AUDIT_PERSIST_DLQ)
    private readonly dlq: Queue,
  ) {
    super();
  }

  async process(job: Job<AuditPersistJobPayload>): Promise<void> {
    await this.chain.persistEvent(job.data);
  }

  @OnWorkerEvent('active')
  onActive(job: Job<AuditPersistJobPayload>): void {
    this.logger.debug(`JOB_STARTED queue=${QUEUE_NAMES.AUDIT_PERSIST} job=${job.id}`);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<AuditPersistJobPayload>): void {
    this.logger.debug(`JOB_COMPLETED queue=${QUEUE_NAMES.AUDIT_PERSIST} job=${job.id}`);
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn(`JOB_STALLED queue=${QUEUE_NAMES.AUDIT_PERSIST} job=${jobId}`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<AuditPersistJobPayload>, error: Error): Promise<void> {
    this.logger.error(
      `JOB_FAILED queue=${QUEUE_NAMES.AUDIT_PERSIST} job=${job.id} attempts=${job.attemptsMade}`,
      error.stack,
    );

    if ((job.attemptsMade ?? 0) < (job.opts.attempts ?? 1)) {
      return;
    }

    await this.dlq.add(
      'audit-dead-letter',
      {
        ...job.data,
        metadata: {
          ...(job.data.metadata ?? {}),
          failedReason: error.message,
          originalJobId: job.id,
          failedAt: new Date().toISOString(),
        },
      },
      { removeOnComplete: false, removeOnFail: false },
    );
  }
}
