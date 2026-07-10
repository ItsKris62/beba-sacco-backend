import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { NotificationPayload } from '../providers/notification-provider.interface';
import { NOTIFICATION_DLQ_JOB_OPTIONS, NOTIFICATION_QUEUE_NAMES } from './queue.constants';

export interface NotificationDlqPayload {
  originalJobId?: string;
  channel: NotificationChannel;
  tenantId: string;
  payload: NotificationPayload;
  failedReason?: string;
  attemptsMade: number;
  failedAt: string;
}

@Injectable()
export class NotificationDlqService {
  constructor(
    @InjectQueue(NOTIFICATION_QUEUE_NAMES.EMAIL_DLQ)
    private readonly emailDlq: Queue<NotificationDlqPayload>,
    @InjectQueue(NOTIFICATION_QUEUE_NAMES.SMS_DLQ)
    private readonly smsDlq: Queue<NotificationDlqPayload>,
    @InjectQueue(NOTIFICATION_QUEUE_NAMES.IN_APP_DLQ)
    private readonly inAppDlq: Queue<NotificationDlqPayload>,
  ) {}

  async moveFailedJob(
    channel: NotificationChannel,
    job: Job<NotificationPayload>,
  ): Promise<Job<NotificationDlqPayload>> {
    const dlq = this.getDlq(channel);

    return dlq.add(
      'dead-letter',
      {
        originalJobId: job.id,
        channel,
        tenantId: job.data.tenantId,
        payload: job.data,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
        failedAt: new Date().toISOString(),
      },
      NOTIFICATION_DLQ_JOB_OPTIONS,
    );
  }

  private getDlq(channel: NotificationChannel): Queue<NotificationDlqPayload> {
    switch (channel) {
      case NotificationChannel.EMAIL:
        return this.emailDlq;
      case NotificationChannel.SMS:
        return this.smsDlq;
      case NotificationChannel.IN_APP:
        return this.inAppDlq;
      default:
        throw new Error(`No notification DLQ configured for channel ${channel}`);
    }
  }
}
