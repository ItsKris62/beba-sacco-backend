import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { AlertsService } from '../alerts/alerts.service';
import { Gauge, register } from 'prom-client';
import Redis from 'ioredis';
import { QueueEvents } from 'bullmq';
import { QUEUE_NAMES } from './queue.constants';

@Injectable()
export class DeadLetterAlertProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeadLetterAlertProcessor.name);
  private redisClient!: Redis;
  private queueEvents: QueueEvents[] = [];
  private dlqGauge: Gauge<string>;
  private alertedQueues = new Set<string>();

  constructor(private readonly alertsService: AlertsService) {
    // Register gauge safely avoiding duplicate registration errors in test environments
    this.dlqGauge = (register.getSingleMetric('bullmq_dlq_depth') as Gauge<string>) || new Gauge({
      name: 'bullmq_dlq_depth',
      help: 'Depth of Dead Letter/Failed Queues',
      labelNames: ['queue'],
    });
  }

  onModuleInit() {
    this.redisClient = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    });

    const connection = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    };

    // Setup near-realtime listeners for all known queues
    for (const queue of Object.values(QUEUE_NAMES)) {
      const qe = new QueueEvents(queue, { connection });

      qe.on('failed', () => this.checkQueueDepth(queue));
      qe.on('retries-exhausted', () => this.checkQueueDepth(queue));
      qe.on('removed', () => this.checkQueueDepth(queue));

      if (queue.toUpperCase().endsWith('DLQ')) {
        qe.on('added', () => this.checkQueueDepth(queue));
      }

      this.queueEvents.push(qe);

      // Initialize metric state
      this.checkQueueDepth(queue).catch(err => 
        this.logger.error(`Initial depth check failed for ${queue}`, err)
      );
    }
  }

  async onModuleDestroy() {
    await Promise.all(this.queueEvents.map(qe => qe.close()));
    if (this.redisClient) {
      this.redisClient.disconnect();
    }
  }

  async checkQueueDepth(queue: string) {
    try {
      // Check standard BullMQ failures AND explicitly routed *_DLQ lists
      const failedCount = await this.redisClient.zcard(`bull:${queue}:failed`);
      const waitingCount = queue.toUpperCase().endsWith('DLQ') ? await this.redisClient.llen(`bull:${queue}:wait`) : 0;

      const totalDlqDepth = failedCount + waitingCount;
      this.dlqGauge.set({ queue }, totalDlqDepth);

      if (totalDlqDepth > 0) {
        if (!this.alertedQueues.has(queue)) {
          this.logger.warn(`DLQ depth for ${queue} is ${totalDlqDepth}. Dispatching alert.`);
          await this.alertsService.sendSlackAlert(`:rotating_light: *DLQ Alert*\nQueue \`${queue}\` has *${totalDlqDepth}* dead letter/failed messages requiring intervention.\n*Action:* Check BullMQ dashboard or DLQ logs.`);
          this.alertedQueues.add(queue); // Suppress spam until queue is drained
        }
      } else {
        this.alertedQueues.delete(queue); // Reset edge-trigger state
      }
    } catch (error) {
      this.logger.error(`Failed to process DLQ metrics for ${queue}`, error);
    }
  }
}
