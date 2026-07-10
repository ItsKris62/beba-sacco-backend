import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { NotificationChannel } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotificationDispatcherService } from '../services/notification-dispatcher.service';
import { NotificationDlqService } from '../queues/notification-dlq.service';
import { SendNotificationJobPayload } from '../queues/notification-job.types';
import { NOTIFICATION_QUEUE_NAMES } from '../queues/queue.constants';
import { BaseNotificationQueueProcessor } from './base-notification-queue.processor';

@Processor(NOTIFICATION_QUEUE_NAMES.EMAIL_QUEUE, { concurrency: 3 })
export class EmailQueueProcessor extends WorkerHost {
  private readonly base: BaseNotificationQueueProcessor;

  constructor(
    prisma: PrismaService,
    dispatcher: NotificationDispatcherService,
    dlqService: NotificationDlqService,
  ) {
    super();
    this.base = new BaseNotificationQueueProcessor(
      EmailQueueProcessor.name,
      NotificationChannel.EMAIL,
      prisma,
      dispatcher,
      dlqService,
    );
  }

  async process(job: Job<SendNotificationJobPayload>): Promise<void> {
    await this.base.handleNotificationJob(job);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<SendNotificationJobPayload> | undefined): Promise<void> {
    await this.base.moveExhaustedFailureToDlq(job);
  }
}
