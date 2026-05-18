import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { AuditPersistJobPayload, QUEUE_NAMES } from '../queue/queue.constants';
import { AuditMaskerService } from './audit.masker.service';

export type CreateAuditEventInput = Omit<AuditPersistJobPayload, 'correlationId' | 'statusCode' | 'success'> & {
  correlationId?: string;
  statusCode?: number;
  success?: boolean;
};

@Injectable()
export class AuditEventService {
  private readonly logger = new Logger(AuditEventService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.AUDIT_PERSIST)
    private readonly auditQueue: Queue<AuditPersistJobPayload>,
    private readonly masker: AuditMaskerService,
  ) {}

  async enqueue(input: CreateAuditEventInput): Promise<void> {
    const payload: AuditPersistJobPayload = {
      correlationId: input.correlationId ?? uuidv4(),
      timestamp: new Date().toISOString(),
      tenantId: input.tenantId,
      userId: input.userId ?? null,
      role: input.role ?? null,
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      oldState: this.mask(input.oldState ?? null),
      newState: this.mask(input.newState ?? null),
      metadata: this.mask(input.metadata ?? null),
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      endpoint: input.endpoint ?? null,
      method: input.method ?? null,
      statusCode: input.statusCode ?? 0,
      success: input.success ?? true,
      errorCode: input.errorCode ?? null,
    };

    try {
      await this.auditQueue.add('persist-audit-event', payload, {
        jobId: `audit:${payload.tenantId}:${payload.correlationId}:${payload.action}:${Date.now()}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 5000 },
        removeOnFail: false,
      });
      this.logger.debug(
        `JOB_ENQUEUED queue=${QUEUE_NAMES.AUDIT_PERSIST} action=${payload.action} correlation=${payload.correlationId}`,
      );
    } catch (error) {
      // HTTP responses must not be blocked by audit backpressure. The failed enqueue
      // is logged loudly so ops can reconcile from application logs if Redis is down.
      this.logger.error(
        `Failed to enqueue audit event action=${payload.action} tenant=${payload.tenantId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  enqueueFireAndForget(input: CreateAuditEventInput): void {
    void this.enqueue(input);
  }

  private mask(value: Record<string, unknown> | null): Record<string, unknown> | null {
    if (value == null) {
      return null;
    }
    return this.masker.maskPII(value);
  }
}
