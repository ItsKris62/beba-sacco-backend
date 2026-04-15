import {
  Injectable, Logger, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma, WebhookStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_NAMES, OutboundWebhookJobPayload } from '../queue/queue.constants';
import { CreateWebhookDto } from './dto/create-webhook.dto';

/**
 * WebhooksService – Phase 4
 *
 * Manages outbound webhook subscriptions and dispatches signed events.
 *
 * Security:
 *   - Each subscription has a unique HMAC-SHA256 secret.
 *   - Every delivery includes `X-Beba-Signature: sha256=<hmac>` and
 *     `X-Beba-Timestamp: <unix-epoch>`.
 *   - Receivers MUST verify the signature using their stored secret.
 *
 * Retry strategy: 3 attempts with exponential back-off via BullMQ.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.OUTBOUND_WEBHOOK)
    private readonly webhookQueue: Queue<OutboundWebhookJobPayload>,
  ) {}

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async create(tenantId: string, dto: CreateWebhookDto) {
    const secret = dto.secret ?? randomBytes(32).toString('hex');

    const subscription = await this.prisma.webhookSubscription.create({
      data: {
        tenantId,
        url: dto.url,
        secret,
        events: dto.events,
        status: WebhookStatus.ACTIVE,
      },
    });

    return { ...subscription, secret }; // Return secret once on creation
  }

  async list(tenantId: string) {
    return this.prisma.webhookSubscription.findMany({
      where: { tenantId },
      select: {
        id: true, url: true, events: true, status: true, createdAt: true, updatedAt: true,
        // Never return the secret in list responses
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async delete(id: string, tenantId: string): Promise<void> {
    const sub = await this.prisma.webhookSubscription.findFirst({ where: { id, tenantId } });
    if (!sub) throw new NotFoundException('Webhook subscription not found');
    await this.prisma.webhookSubscription.delete({ where: { id } });
  }

  async setStatus(id: string, tenantId: string, status: WebhookStatus) {
    const sub = await this.prisma.webhookSubscription.findFirst({ where: { id, tenantId } });
    if (!sub) throw new NotFoundException('Webhook subscription not found');
    return this.prisma.webhookSubscription.update({ where: { id }, data: { status } });
  }

  // ── DISPATCH ─────────────────────────────────────────────────────────────

  /**
   * Fan-out an event to all active subscriptions that match the event type.
   * Creates WebhookDelivery records and enqueues BullMQ jobs.
   * Fire-and-forget – never throws.
   */
  async dispatch(tenantId: string, event: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const subscriptions = await this.prisma.webhookSubscription.findMany({
        where: { tenantId, status: WebhookStatus.ACTIVE, events: { has: event } },
      });

      for (const sub of subscriptions) {
        const delivery = await this.prisma.webhookDelivery.create({
          data: {
            subscriptionId: sub.id,
            event,
            payload: payload as Prisma.InputJsonValue,
            status: 'PENDING',
          },
        });

        await this.webhookQueue.add(
          'deliver',
          {
            subscriptionId: sub.id,
            deliveryId: delivery.id,
            event,
            payload,
            attempt: 1,
          },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: 500,
          },
        );
      }
    } catch (err) {
      this.logger.error(`Webhook dispatch failed: event=${event} tenant=${tenantId}`, err);
    }
  }

  // ── DELIVERY (called by processor) ───────────────────────────────────────

  async deliverOne(
    subscriptionId: string,
    deliveryId: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const sub = await this.prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new NotFoundException(`Webhook subscription ${subscriptionId} not found`);

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ event, timestamp, data: payload });
    const signature = createHmac('sha256', sub.secret).update(`${timestamp}.${body}`).digest('hex');

    let httpStatus: number | null = null;
    let responseBody: string | null = null;
    let success = false;

    try {
      const res = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Beba-Signature': `sha256=${signature}`,
          'X-Beba-Timestamp': timestamp,
          'X-Beba-Event': event,
        },
        body,
        signal: AbortSignal.timeout(10_000), // 10 s timeout
      });

      httpStatus = res.status;
      responseBody = await res.text().catch(() => '');
      success = res.ok;

      if (!success) {
        throw new BadRequestException(`Webhook target returned HTTP ${httpStatus}`);
      }
    } catch (err) {
      this.logger.warn(`Webhook delivery failed: sub=${subscriptionId} event=${event}`, err);
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'FAILED',
          httpStatus,
          responseBody,
          attempts: { increment: 1 },
        },
      });
      throw err; // Re-throw so BullMQ retries
    }

    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'DELIVERED',
        httpStatus,
        responseBody,
        attempts: { increment: 1 },
        deliveredAt: new Date(),
      },
    });

    this.logger.log(`Webhook delivered: sub=${subscriptionId} event=${event} status=${httpStatus}`);
  }

  async getDeliveries(subscriptionId: string, tenantId: string) {
    const sub = await this.prisma.webhookSubscription.findFirst({ where: { id: subscriptionId, tenantId } });
    if (!sub) throw new NotFoundException('Webhook subscription not found');

    return this.prisma.webhookDelivery.findMany({
      where: { subscriptionId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
