import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationChannel,
  NotificationLog,
  NotificationStatus,
  Prisma,
} from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  GetNotificationLogsDto,
  NotificationLogSortField,
} from '../dto/get-notification-logs.dto';
import {
  SEND_NOTIFICATION_JOB,
  SendNotificationJobPayload,
} from '../queues/notification-job.types';
import { NOTIFICATION_JOB_OPTIONS, NOTIFICATION_QUEUE_NAMES } from '../queues/queue.constants';

export interface PaginatedNotificationLogs {
  data: NotificationLog[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

@Injectable()
export class AdminNotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(NOTIFICATION_QUEUE_NAMES.EMAIL_QUEUE)
    private readonly emailQueue: Queue<SendNotificationJobPayload>,
    @InjectQueue(NOTIFICATION_QUEUE_NAMES.SMS_QUEUE)
    private readonly smsQueue: Queue<SendNotificationJobPayload>,
    @InjectQueue(NOTIFICATION_QUEUE_NAMES.IN_APP_QUEUE)
    private readonly inAppQueue: Queue<SendNotificationJobPayload>,
  ) {}

  async getLogs(
    tenantId: string,
    query: GetNotificationLogsDto,
  ): Promise<PaginatedNotificationLogs> {
    const db = this.prisma.forContext(tenantId);
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;
    const where = this.buildWhere(query);
    const orderBy = this.buildOrderBy(query.sortBy, query.sortOrder);

    const [data, total] = await Promise.all([
      db.notificationLog.findMany({
        where,
        orderBy,
        skip,
        take: limit,
      }),
      db.notificationLog.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async retryNotification(tenantId: string, notificationId: string): Promise<NotificationLog> {
    const db = this.prisma.forContext(tenantId);
    const log = await db.notificationLog.findFirst({
      where: { id: notificationId },
    });

    if (!log) {
      throw new NotFoundException('Notification log not found');
    }

    if (log.status !== NotificationStatus.FAILED) {
      throw new ConflictException('Only failed notifications can be retried');
    }

    const payload = this.extractPayload(log);
    const updated = await db.notificationLog.updateMany({
      where: {
        id: notificationId,
        status: NotificationStatus.FAILED,
      },
      data: {
        status: NotificationStatus.PENDING,
        failReason: null,
        providerResponse: Prisma.JsonNull,
        providerRef: null,
        sentAt: null,
        deliveredAt: null,
      },
    });

    if (updated.count !== 1) {
      throw new ConflictException('Notification retry is already pending');
    }

    try {
      await this.enqueueRetry(payload);
    } catch (error) {
      await db.notificationLog.updateMany({
        where: { id: notificationId },
        data: {
          status: NotificationStatus.FAILED,
          failReason: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }

    const retried = await db.notificationLog.findFirst({
      where: { id: notificationId },
    });

    if (!retried) {
      throw new NotFoundException('Notification log not found after retry');
    }

    return retried;
  }

  private buildWhere(query: GetNotificationLogsDto): Prisma.NotificationLogWhereInput {
    return {
      ...(query.status ? { status: query.status } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.eventType ? { eventType: query.eventType } : {}),
      ...(query.recipient
        ? {
            recipient: {
              contains: query.recipient,
              mode: Prisma.QueryMode.insensitive,
            },
          }
        : {}),
    };
  }

  private buildOrderBy(
    sortBy: NotificationLogSortField = 'createdAt',
    sortOrder: 'asc' | 'desc' = 'desc',
  ): Prisma.NotificationLogOrderByWithRelationInput {
    return { [sortBy]: sortOrder };
  }

  private extractPayload(log: NotificationLog): SendNotificationJobPayload {
    const payload = log.payload;
    if (!this.isSendNotificationJobPayload(payload)) {
      throw new BadRequestException('Notification log payload cannot be retried');
    }

    if (payload.tenantId !== log.tenantId) {
      throw new BadRequestException('Notification payload tenant mismatch');
    }

    if (payload.channel !== log.channel) {
      throw new BadRequestException('Notification payload channel mismatch');
    }

    return payload;
  }

  private async enqueueRetry(payload: SendNotificationJobPayload): Promise<Job<SendNotificationJobPayload>> {
    const queue = this.queueForChannel(payload.channel);
    const existingJob = await queue.getJob(payload.dedupeKey);

    if (existingJob) {
      const state = await existingJob.getState();
      if (state === 'failed') {
        await existingJob.retry('failed');
      }

      return existingJob;
    }

    return queue.add(SEND_NOTIFICATION_JOB, payload, {
      ...NOTIFICATION_JOB_OPTIONS,
      jobId: payload.dedupeKey,
    });
  }

  private queueForChannel(channel: NotificationChannel): Queue<SendNotificationJobPayload> {
    switch (channel) {
      case NotificationChannel.EMAIL:
        return this.emailQueue;
      case NotificationChannel.SMS:
        return this.smsQueue;
      case NotificationChannel.IN_APP:
        return this.inAppQueue;
      default:
        throw new BadRequestException(`Unsupported retry channel: ${channel}`);
    }
  }

  private isSendNotificationJobPayload(value: unknown): value is SendNotificationJobPayload {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const payload = value as Partial<SendNotificationJobPayload>;
    return (
      typeof payload.tenantId === 'string' &&
      typeof payload.eventType === 'string' &&
      typeof payload.recipient === 'string' &&
      typeof payload.templateId === 'string' &&
      typeof payload.body === 'string' &&
      typeof payload.dedupeKey === 'string' &&
      Object.values(NotificationChannel).includes(payload.channel as NotificationChannel)
    );
  }
}
