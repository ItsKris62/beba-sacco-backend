import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationChannel } from '@prisma/client';
import { AfricasTalkingProvider } from '../providers/africas-talking.provider';
import { InAppProvider } from '../providers/in-app.provider';
import {
  NotificationPayload,
  ProviderResponse,
} from '../providers/notification-provider.interface';
import { NotificationProviderException } from '../providers/notification-provider.exception';
import { SendGridProvider } from '../providers/sendgrid.provider';

@Injectable()
export class NotificationDispatcherService {
  constructor(
    private readonly configService: ConfigService,
    private readonly smsProvider: AfricasTalkingProvider,
    private readonly emailProvider: SendGridProvider,
    private readonly inAppProvider: InAppProvider,
  ) {}

  async dispatch(
    channel: NotificationChannel,
    payload: NotificationPayload,
  ): Promise<ProviderResponse> {
    if (this.configService.get<boolean>('app.notifications.mockMode', false)) {
      console.log('[Notification mock mode]', {
        channel,
        tenantId: payload.tenantId,
        recipient: payload.recipient,
        subject: payload.subject,
        body: payload.body,
        metadata: payload.metadata,
      });

      return {
        success: true,
        providerRef: `mock:${channel}:${Date.now()}`,
        rawResponse: { mock: true },
      };
    }

    switch (channel) {
      case NotificationChannel.EMAIL:
        return this.emailProvider.send(payload);
      case NotificationChannel.SMS:
        return this.smsProvider.send(payload);
      case NotificationChannel.IN_APP:
        return this.inAppProvider.send(payload);
      default:
        throw new NotificationProviderException(
          `Unsupported notification channel: ${channel}`,
          'dispatcher',
        );
    }
  }
}
