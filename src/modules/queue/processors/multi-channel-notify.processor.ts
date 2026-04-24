import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, MultiChannelNotifyJobPayload } from '../queue.constants';
import { NotificationsService } from '../../integrations/notifications/notifications.service';

@Processor(QUEUE_NAMES.NOTIFY_MULTI)
export class MultiChannelNotifyProcessor extends WorkerHost {
  private readonly logger = new Logger(MultiChannelNotifyProcessor.name);

  constructor(private readonly notifications: NotificationsService) {
    super();
  }

  async process(job: Job<MultiChannelNotifyJobPayload>): Promise<void> {
    this.logger.log(`Processing notification: id=${job.data.notificationId} channel=${job.data.channel}`);
    await this.notifications.deliver(job.data.notificationId);
  }
}
