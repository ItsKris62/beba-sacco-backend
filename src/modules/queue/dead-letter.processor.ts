import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  private redisClient?: Redis;
  private dlqGauge: Gauge<string>;
  private alertedQueues = new Set<string>();

  constructor(private readonly alertsService: AlertsService, private readonly configService: ConfigService) {
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
    const bullRedisUrl = this.configService.get<string>('app.bullRedis.url');
    const rawBullHost = this.configService.get<string>('app.bullRedis.host');
    const bullPassword = this.configService.get<string>('app.bullRedis.password');
    const bullTls = this.configService.get<boolean>('app.bullRedis.tls');

    if (bullRedisUrl) {
      const parsed = new URL(bullRedisUrl);
      this.redisClient = new Redis({
        host: parsed.hostname,
        port: parseInt(parsed.port || '6379', 10),
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        tls: parsed.protocol === 'rediss:' ? { rejectUnauthorized: false } : undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        retryStrategy: (times: number) => Math.min(times * 500, 10_000),
      });
      this.attachErrorHandler(this.redisClient);
      return;
    }

    if (rawBullHost) {
      this.redisClient = new Redis({
        host: rawBullHost.replace(/^https?:\/\//, ''),
        port: this.configService.get<number>('app.bullRedis.port', 6379),
        password: bullPassword || undefined,
        tls: bullTls ? { rejectUnauthorized: false } : undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        retryStrategy: (times: number) => Math.min(times * 500, 10_000),
      });
      this.attachErrorHandler(this.redisClient);
      return;
    }

    this.logger.warn(
      'DLQ monitor disabled: Bull Redis is not configured. Set BULL_REDIS_URL or BULL_REDIS_HOST; refusing to use app Redis for BullMQ metrics.',
    );
  }

  /**
   * Attach an error listener immediately after client construction. ioredis
   * (and, transitively, the underlying net.Socket) crashes the whole Node
   * process on an unhandled 'error' event — e.g. ECONNRESET when Render
   * resets an idle TCP connection. Every raw ioredis client needs one.
   */
  private attachErrorHandler(client: Redis): void {
    client.on('error', (err: Error) => {
      this.logger.warn(`DLQ monitor Redis error (non-fatal): ${err.message}`);
    });
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async monitorDlq() {
    if (!this.redisClient) {
      return;
    }

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

