import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sgMail from '@sendgrid/mail';
import {
  INotificationProvider,
  NotificationPayload,
  ProviderResponse,
} from './notification-provider.interface';
import { NotificationProviderException } from './notification-provider.exception';

@Injectable()
export class SendGridProvider implements INotificationProvider {
  private readonly logger = new Logger(SendGridProvider.name);

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('app.sendGrid.apiKey');
    if (apiKey) {
      sgMail.setApiKey(apiKey);
    }
  }

  async send(payload: NotificationPayload): Promise<ProviderResponse> {
    const apiKey = this.configService.get<string>('app.sendGrid.apiKey');
    const fromEmail = this.configService.get<string>(
      'app.sendGrid.fromEmail',
      'noreply@beba-sacco.com',
    );
    const fromName = this.configService.get<string>('app.sendGrid.fromName', 'Beba SACCO');

    if (!apiKey) {
      throw new NotificationProviderException('SendGrid API key is not configured', 'sendGrid');
    }

    if (!payload.subject) {
      throw new NotificationProviderException('Email subject is required', 'sendGrid');
    }

    try {
      sgMail.setApiKey(apiKey);
      const [response] = await sgMail.send({
        to: payload.recipient,
        from: { email: fromEmail, name: fromName },
        subject: payload.subject,
        html: payload.body,
      });

      const providerRef = this.getMessageId(response.headers);

      return {
        success: true,
        providerRef,
        rawResponse: {
          statusCode: response.statusCode,
          headers: response.headers,
        },
      };
    } catch (error: unknown) {
      this.logger.error('SendGrid email send failed', error);
      throw new NotificationProviderException(
        error instanceof Error ? error.message : 'SendGrid email send failed',
        'sendGrid',
        error,
      );
    }
  }

  private getMessageId(headers: Record<string, string | string[] | undefined>): string | undefined {
    const value = headers['x-message-id'];
    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }
}
