import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, OutboundWebhookJobPayload } from '../queue.constants';
import { WebhooksService } from '../../webhooks/webhooks.service';

/**
 * Delivers outbound webhook payloads to tenant-configured endpoints.
 *
 * Concurrency = 3: tuned for low-tier Redis command budgets.
 * BullMQ handles retries (3x, exponential back-off) on thrown errors.
 */
@Processor(QUEUE_NAMES.OUTBOUND_WEBHOOK, {
  concurrency: 3,
  lockDuration: 60000,
  stalledInterval: 60000,
  maxStalledCount: 1,
})
export class OutboundWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboundWebhookProcessor.name);

  constructor(private readonly webhooks: WebhooksService) {
    super();
  }

  async process(job: Job<OutboundWebhookJobPayload>): Promise<void> {
    const { subscriptionId, deliveryId, event } = job.data;
    this.logger.debug(`Delivering webhook: sub=${subscriptionId} event=${event}`);
    await this.webhooks.deliverOne(subscriptionId, deliveryId, event);
  }
}


