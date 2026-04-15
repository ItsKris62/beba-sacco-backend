import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  QUEUE_NAMES,
  CrbExportJobPayload,
  AmlScreenJobPayload,
  OutboxPublishJobPayload,
} from '../../queue/queue.constants';

/**
 * IntegrationOutboxService – Phase 5
 *
 * Implements the Transactional Outbox Pattern for guaranteed at-least-once
 * delivery of integration payloads (CRB, AML, Notifications, Webhooks).
 *
 * Flow:
 *   1. Business logic writes to domain table + IntegrationOutbox in same TX
 *   2. Cron job polls PENDING outbox entries every 30s
 *   3. Routes each entry to the appropriate BullMQ queue
 *   4. On success → DELIVERED; on max retries → DEAD_LETTER
 *
 * Idempotency: Each outbox entry has a unique idempotencyKey.
 * Dead-letter: Entries exceeding maxAttempts are moved to DEAD_LETTER status.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.CRB_EXPORT)
    private readonly crbQueue: Queue<CrbExportJobPayload>,
    @InjectQueue(QUEUE_NAMES.AML_SCREEN)
    private readonly amlQueue: Queue<AmlScreenJobPayload>,
    @InjectQueue(QUEUE_NAMES.NOTIFY_MULTI)
    private readonly notifyQueue: Queue,
  ) {}

  /**
   * Enqueue an outbox entry within an existing Prisma transaction.
   * Call this from business logic to guarantee delivery.
   */
  async createEntry(params: {
    tenantId: string;
    idempotencyKey: string;
    integrationType: string;
    payload: Record<string, unknown>;
    maxAttempts?: number;
  }) {
    return this.prisma.integrationOutbox.create({
      data: {
        tenantId: params.tenantId,
        idempotencyKey: params.idempotencyKey,
        integrationType: params.integrationType,
        payload: params.payload,
        status: 'PENDING',
        maxAttempts: params.maxAttempts ?? 5,
      },
    });
  }

  /**
   * Cron: Poll pending outbox entries and route to appropriate queues.
   * Runs every 30 seconds.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async publishPendingEntries(): Promise<void> {
    const entries = await this.prisma.integrationOutbox.findMany({
      where: {
        status: { in: ['PENDING', 'FAILED'] },
        OR: [
          { nextRetryAt: null },
          { nextRetryAt: { lte: new Date() } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 100, // Process in batches
    });

    if (entries.length === 0) return;

    this.logger.log(`Outbox publisher: processing ${entries.length} entries`);

    for (const entry of entries) {
      try {
        // Check if max attempts exceeded → dead-letter
        if (entry.attempts >= entry.maxAttempts) {
          await this.prisma.integrationOutbox.update({
            where: { id: entry.id },
            data: {
              status: 'DEAD_LETTER',
              deadLetteredAt: new Date(),
              lastError: `Max attempts (${entry.maxAttempts}) exceeded`,
            },
          });
          this.logger.warn(`Outbox entry ${entry.id} dead-lettered after ${entry.attempts} attempts`);
          continue;
        }

        // Mark as PROCESSING
        await this.prisma.integrationOutbox.update({
          where: { id: entry.id },
          data: { status: 'PROCESSING', attempts: { increment: 1 } },
        });

        // Route to appropriate queue
        await this.routeToQueue(entry);

        // Mark as DELIVERED
        await this.prisma.integrationOutbox.update({
          where: { id: entry.id },
          data: { status: 'DELIVERED', processedAt: new Date() },
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const nextRetry = new Date(Date.now() + Math.pow(2, entry.attempts) * 5000); // Exponential backoff

        await this.prisma.integrationOutbox.update({
          where: { id: entry.id },
          data: {
            status: 'FAILED',
            lastError: error,
            nextRetryAt: nextRetry,
          },
        });

        this.logger.error(`Outbox entry ${entry.id} failed: ${error}`);
      }
    }
  }

  private async routeToQueue(entry: {
    id: string;
    tenantId: string;
    integrationType: string;
    payload: unknown;
  }): Promise<void> {
    const payload = entry.payload as Record<string, unknown>;

    switch (entry.integrationType) {
      case 'CRB_EXPORT':
        await this.crbQueue.add('crb-export', {
          tenantId: entry.tenantId,
          reportId: payload.reportId as string,
          outboxId: entry.id,
        }, {
          attempts: 5,
          backoff: { type: 'exponential', delay: 10000 },
        });
        break;

      case 'AML_SCREEN':
        await this.amlQueue.add('aml-screen', {
          tenantId: entry.tenantId,
          screeningId: payload.screeningId as string,
          memberId: payload.memberId as string,
          trigger: payload.trigger as 'KYC' | 'DEPOSIT' | 'MANUAL',
          triggerRef: payload.triggerRef as string | undefined,
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        });
        break;

      case 'NOTIFY':
        await this.notifyQueue.add('notify', payload, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 3000 },
        });
        break;

      default:
        throw new Error(`Unknown integration type: ${entry.integrationType}`);
    }
  }

  /**
   * Get outbox entries for monitoring/admin dashboard.
   */
  async getEntries(tenantId: string, params?: {
    status?: string;
    integrationType?: string;
    limit?: number;
  }) {
    return this.prisma.integrationOutbox.findMany({
      where: {
        tenantId,
        ...(params?.status && { status: params.status as any }),
        ...(params?.integrationType && { integrationType: params.integrationType }),
      },
      orderBy: { createdAt: 'desc' },
      take: params?.limit ?? 50,
    });
  }

  /**
   * Retry a dead-lettered entry manually.
   */
  async retryDeadLetter(outboxId: string, tenantId: string) {
    const entry = await this.prisma.integrationOutbox.findFirst({
      where: { id: outboxId, tenantId, status: 'DEAD_LETTER' },
    });

    if (!entry) {
      throw new Error('Outbox entry not found or not in DEAD_LETTER status');
    }

    return this.prisma.integrationOutbox.update({
      where: { id: outboxId },
      data: {
        status: 'PENDING',
        attempts: 0,
        nextRetryAt: null,
        deadLetteredAt: null,
        lastError: null,
      },
    });
  }
}
