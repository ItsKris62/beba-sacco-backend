import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { NotificationDlqService } from './queues/notification-dlq.service';
import { NOTIFICATION_JOB_OPTIONS, NOTIFICATION_QUEUE_NAMES } from './queues/queue.constants';

@Module({
  imports: [
    BullModule.registerQueue(
      {
        name: NOTIFICATION_QUEUE_NAMES.EMAIL_QUEUE,
        defaultJobOptions: NOTIFICATION_JOB_OPTIONS,
      },
      {
        name: NOTIFICATION_QUEUE_NAMES.SMS_QUEUE,
        defaultJobOptions: NOTIFICATION_JOB_OPTIONS,
      },
      {
        name: NOTIFICATION_QUEUE_NAMES.IN_APP_QUEUE,
        defaultJobOptions: NOTIFICATION_JOB_OPTIONS,
      },
      { name: NOTIFICATION_QUEUE_NAMES.EMAIL_DLQ },
      { name: NOTIFICATION_QUEUE_NAMES.SMS_DLQ },
      { name: NOTIFICATION_QUEUE_NAMES.IN_APP_DLQ },
    ),
  ],
  providers: [NotificationDlqService],
  exports: [BullModule, NotificationDlqService],
})
export class NotificationsQueueModule {}
