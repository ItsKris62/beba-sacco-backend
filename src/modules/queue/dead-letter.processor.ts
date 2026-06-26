import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { AlertsService } from '../alerts/alerts.service';
import { Gauge, register } from 'prom-client';
import Redis from 'ioredis';
import { Cron, CronExpression } from '@nestjs/schedule';
import { QUEUE_NAMES } from './queue.constants';

/**
 * DeadLetterAlertProcessor monitors dead-letter (failed) queues.
 * It runs a cron job every 5 minutes to check queue depths using a raw ioredis client.
 * Alerts are sent via AlertsService when any DLQ has pending messages.
 */
@Injectable()
export class DeadLetterAlertProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeadLetterAlertProcessor.name);
  private redisClient!: Redis;
  private dlqGauge: Gauge<string>;
  private alertedQueues = new Set<string>();

  constructor(private readonly alertsService: AlertsService) {
    // Register gauge safely avoiding duplicate registration errors in test environments
    this.dlqGauge =
      (register.getSingleMetric('bullmq_dlq_depth') as Gauge<string>) ||
      new Gauge({
        name: 'bullmq_dlq_depth',
        help: 'Depth of Dead Letter/Failed Queues',
        labelNames: ['queue'],
      });
  }

  onModuleInit() {
    // Initialize Redis client with Upstash‑compatible options
    this.redisClient = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async monitorDlq() {
    const dlqQueues = Object.values(QUEUE_NAMES).filter((q) => q.toUpperCase().endsWith('DLQ'));
    for (const queue of dlqQueues) {
      try {
        const failedCount = await this.redisClient.zcard(`bull:${queue}:failed`);
        this.dlqGauge.set({ queue }, failedCount);
        if (failedCount > 0) {
          if (!this.alertedQueues.has(queue)) {
            this.logger.warn(`DLQ depth for ${queue} is ${failedCount}. Dispatching alert.`);
            await this.alertsService.sendSlackAlert(
              `:rotating_light: *DLQ Alert*\nQueue \`${queue}\` has *${failedCount}* dead letter/failed messages requiring intervention.\n*Action:* Check BullMQ dashboard or DLQ logs.`,
            );
            this.alertedQueues.add(queue);
          }
        } else {
          // Reset edge‑trigger state when queue is drained
          this.alertedQueues.delete(queue);
        }
      } catch (error) {
        this.logger.error(`Failed to process DLQ metrics for ${queue}`, error);
      }
    }
  }

  async onModuleDestroy() {
    if (this.redisClient) {
      this.redisClient.disconnect();
    }
  }
}
