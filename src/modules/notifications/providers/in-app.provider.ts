import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  INotificationProvider,
  NotificationPayload,
  ProviderResponse,
} from './notification-provider.interface';
import { NotificationProviderException } from './notification-provider.exception';

@Injectable()
export class InAppProvider implements INotificationProvider {
  constructor(private readonly prisma: PrismaService) {}

  async send(payload: NotificationPayload): Promise<ProviderResponse> {
    const title = this.asString(payload.metadata?.title) ?? payload.subject ?? 'Notification';
    const type = this.asString(payload.metadata?.type) ?? 'SYSTEM';

    try {
      const notification = await this.prisma.inAppNotification.create({
        data: {
          tenantId: payload.tenantId,
          userId: payload.recipient,
          title,
          body: payload.body,
          type,
          isRead: false,
        },
      });

      return {
        success: true,
        providerRef: notification.id,
        rawResponse: notification,
      };
    } catch (error: unknown) {
      throw new NotificationProviderException(
        error instanceof Error ? error.message : 'In-app notification write failed',
        'inApp',
        error,
      );
    }
  }

  private asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }
}
