import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, AuditLogJobPayload } from '../queue.constants';
import { AuditService } from '../../audit/audit.service';

/**
 * Async audit log writer.
 * Fire-and-forget from hot paths — the queue absorbs backpressure.
 *
 * Retry: fire-and-forget semantics (maxAttempts=1 in job options).
 * A missed audit log is never worth blocking a business transaction.
 */
@Processor(QUEUE_NAMES.AUDIT_LOG, {
  concurrency: 10,
})
export class AuditLogProcessor extends WorkerHost {
  private readonly logger = new Logger(AuditLogProcessor.name);

  constructor(private readonly auditService: AuditService) {
    super();
  }

  async process(job: Job<AuditLogJobPayload>): Promise<void> {
    try {
      await this.auditService.create(job.data);
    } catch (err: unknown) {
      // Log but don't rethrow — audit failures must not cascade
      this.logger.error(
        `audit.log job ${job.id} failed`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
