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

const AUDIT_MAX_FIELD_BYTES = 4096;
const AUDIT_MAX_STRING_BYTES = 1024;
const AUDIT_MAX_DEPTH = 4;
const AUDIT_MAX_ARRAY_ITEMS = 25;
const AUDIT_MAX_OBJECT_KEYS = 50;

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
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: { age: 604800, count: 500 },
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
    return this.boundRecord(this.masker.maskPII(value));
  }

  private boundRecord(value: Record<string, unknown>): Record<string, unknown> {
    const bounded = this.boundValue(value, 0);
    const record = this.isRecord(bounded) ? bounded : { value: bounded };
    return this.truncateToBytes(record, AUDIT_MAX_FIELD_BYTES);
  }

  private boundValue(value: unknown, depth: number): unknown {
    if (value == null || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      return this.truncateString(value, AUDIT_MAX_STRING_BYTES);
    }

    if (depth >= AUDIT_MAX_DEPTH) {
      return '[Truncated: max audit depth reached]';
    }

    if (Array.isArray(value)) {
      const items = value
        .slice(0, AUDIT_MAX_ARRAY_ITEMS)
        .map((item) => this.boundValue(item, depth + 1));
      if (value.length > AUDIT_MAX_ARRAY_ITEMS) {
        items.push(`[Truncated: ${value.length - AUDIT_MAX_ARRAY_ITEMS} additional items]`);
      }
      return items;
    }

    if (this.isRecord(value)) {
      const output: Record<string, unknown> = {};
      const entries = Object.entries(value).slice(0, AUDIT_MAX_OBJECT_KEYS);
      for (const [key, child] of entries) {
        output[key] = this.boundValue(child, depth + 1);
      }
      const omitted = Object.keys(value).length - entries.length;
      if (omitted > 0) {
        output.__truncatedKeys = omitted;
      }
      return output;
    }

    return this.truncateString(String(value), AUDIT_MAX_STRING_BYTES);
  }

  private truncateToBytes(
    value: Record<string, unknown>,
    maxBytes: number,
  ): Record<string, unknown> {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes) {
      return value;
    }

    return {
      __truncated: true,
      summary: this.truncateString(JSON.stringify(value), maxBytes - 128),
    };
  }

  private truncateString(value: string, maxBytes: number): string {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
      return value;
    }

    let end = Math.min(value.length, maxBytes);
    while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) {
      end -= 1;
    }
    return `${value.slice(0, end)}...[truncated]`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}



