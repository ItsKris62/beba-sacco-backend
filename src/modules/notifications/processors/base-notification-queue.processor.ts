import { Logger } from '@nestjs/common';
import { NotificationChannel, NotificationStatus, Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotificationDlqService } from '../queues/notification-dlq.service';
import {
  SEND_NOTIFICATION_JOB,
  SendNotificationJobPayload,
} from '../queues/notification-job.types';
import { NotificationProviderException } from '../providers/notification-provider.exception';
import { NotificationPayload } from '../providers/notification-provider.interface';
import { NotificationDispatcherService } from '../services/notification-dispatcher.service';

export class BaseNotificationQueueProcessor {
  protected readonly logger: Logger;

  constructor(
    processorName: string,
    protected readonly channel: NotificationChannel,
    protected readonly prisma: PrismaService,
    protected readonly dispatcher: NotificationDispatcherService,
    protected readonly dlqService: NotificationDlqService,
  ) {
    this.logger = new Logger(processorName);
  }

  async handleNotificationJob(job: Job<SendNotificationJobPayload>): Promise<void> {
    if (job.name !== SEND_NOTIFICATION_JOB) {
      this.logger.warn(`Skipping unsupported notification job: ${job.name}`);
      return;
    }

    const data = job.data;
    if (!data.tenantId) {
      throw new Error(`Notification job ${job.id ?? data.dedupeKey} is missing tenantId`);
    }

    if (data.channel !== this.channel) {
      throw new Error(
        `Notification job ${job.id ?? data.dedupeKey} channel ${data.channel} cannot run on ${this.channel}`,
      );
    }

    const db = this.prisma.forContext(data.tenantId);
    const auditPayload = this.auditPayload(job);
    let log = await db.notificationLog.findFirst({
      where: {
        eventType: data.eventType,
        channel: data.channel,
        recipient: data.recipient,
        templateId: data.templateId,
        payload: {
          path: ['dedupeKey'],
          equals: data.dedupeKey,
        },
      },
    });

    if (!log) {
      log = await db.notificationLog.create({
        data: {
          tenantId: data.tenantId,
          memberId: data.memberId,
          eventType: data.eventType,
          channel: data.channel,
          recipient: data.recipient,
          templateId: data.templateId,
          payload: auditPayload,
          status: NotificationStatus.PENDING,
        },
      });
    } else if (
      log.status === NotificationStatus.DELIVERED ||
      log.status === NotificationStatus.SENT
    ) {
      this.logger.debug(`Skipping already delivered notification log ${log.id}`);
      return;
    } else {
      await db.notificationLog.updateMany({
        where: { id: log.id },
        data: {
          status: NotificationStatus.PENDING,
          failReason: null,
          payload: auditPayload,
        },
      });
    }

    try {
      const response = await this.dispatch(data, log.id);
      await db.notificationLog.updateMany({
        where: { id: log.id },
        data: {
          status: NotificationStatus.DELIVERED,
          providerRef: response.providerRef,
          providerResponse: this.toInputJson(response.rawResponse),
          sentAt: new Date(),
          deliveredAt: new Date(),
          failReason: null,
        },
      });
    } catch (error) {
      await db.notificationLog.updateMany({
        where: { id: log.id },
        data: {
          status: NotificationStatus.FAILED,
          failReason: this.errorMessage(error),
          providerResponse: this.toInputJson(this.errorPayload(error)),
        },
      });

      throw error;
    }
  }

  async moveExhaustedFailureToDlq(
    job: Job<SendNotificationJobPayload> | undefined,
  ): Promise<void> {
    if (!job) {
      return;
    }

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      return;
    }

    try {
      await this.dlqService.moveFailedJob(this.channel, job);
    } catch (error) {
      this.logger.error(
        `Failed to move notification job ${job.id ?? job.data.dedupeKey} to DLQ`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async dispatch(data: SendNotificationJobPayload, notificationLogId: string) {
    const payload: NotificationPayload = {
      tenantId: data.tenantId,
      recipient: data.recipient,
      subject: data.subject,
      body: data.body,
      metadata: {
        ...data.metadata,
        notificationLogId,
        dedupeKey: data.dedupeKey,
        memberId: data.memberId,
        userId: data.userId,
        entityId: data.entityId,
      },
    };

    return this.dispatcher.dispatch(data.channel, payload);
  }

  private auditPayload(job: Job<SendNotificationJobPayload>): Prisma.InputJsonValue {
    return {
      ...job.data,
      bullJobId: job.id,
      attemptsMade: job.attemptsMade,
    } as Prisma.InputJsonObject;
  }

  private toInputJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined) {
      return undefined;
    }

    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private errorPayload(error: unknown): Prisma.InputJsonValue {
    if (error instanceof NotificationProviderException) {
      return {
        name: error.name,
        provider: error.provider,
        message: error.message,
      };
    }

    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
      };
    }

    return { message: String(error) };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
