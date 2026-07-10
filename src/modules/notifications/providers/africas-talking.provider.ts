import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizePhone } from '../../data-import/utils/phone-normalizer';
import {
  INotificationProvider,
  NotificationPayload,
  ProviderResponse,
} from './notification-provider.interface';
import { NotificationProviderException } from './notification-provider.exception';

// africastalking ships without TypeScript declarations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AfricasTalking = require('africastalking') as (opts: {
  apiKey: string;
  username: string;
}) => {
  SMS: {
    send: (params: { to: string[]; message: string; from?: string }) => Promise<{
      SMSMessageData?: {
        Message?: string;
        Recipients?: Array<{
          status: string;
          number: string;
          messageId?: string;
          cost?: string;
        }>;
      };
    }>;
  };
};

@Injectable()
export class AfricasTalkingProvider implements INotificationProvider {
  private readonly logger = new Logger(AfricasTalkingProvider.name);

  constructor(private readonly configService: ConfigService) {}

  async send(payload: NotificationPayload): Promise<ProviderResponse> {
    const recipient = this.formatPhoneE164(payload.recipient);
    if (!recipient) {
      throw new NotificationProviderException(
        'Invalid SMS recipient phone number',
        'africasTalking',
      );
    }

    const username =
      this.configService.get<string>('app.africasTalking.username') ??
      this.configService.get<string>('AFRICASTALKING_USERNAME');
    const apiKey =
      this.configService.get<string>('app.africasTalking.apiKey') ??
      this.configService.get<string>('AFRICASTALKING_API_KEY');
    const senderId =
      this.configService.get<string>('app.africasTalking.senderId') ??
      this.configService.get<string>('AFRICASTALKING_SENDER') ??
      this.configService.get<string>('AFRICASTALKING_SENDER_ID');

    if (!username || !apiKey) {
      throw new NotificationProviderException(
        "Africa's Talking credentials are not configured",
        'africasTalking',
      );
    }

    try {
      const client = AfricasTalking({ username, apiKey });
      const response = await client.SMS.send({
        to: [recipient],
        message: payload.body,
        ...(senderId ? { from: senderId } : {}),
      });

      const recipients = response.SMSMessageData?.Recipients ?? [];
      const accepted = recipients.some((entry) => entry.status === 'Success');
      const providerRef = recipients.find((entry) => entry.messageId)?.messageId;

      if (!accepted) {
        throw new NotificationProviderException(
          `Africa's Talking rejected SMS recipient: ${JSON.stringify(recipients)}`,
          'africasTalking',
          response,
        );
      }

      return {
        success: true,
        providerRef,
        rawResponse: response,
      };
    } catch (error: unknown) {
      if (error instanceof NotificationProviderException) {
        throw error;
      }

      this.logger.error("Africa's Talking SMS send failed", error);
      throw new NotificationProviderException(
        error instanceof Error ? error.message : "Africa's Talking SMS send failed",
        'africasTalking',
        error,
      );
    }
  }

  private formatPhoneE164(phone: string): string | null {
    const { normalized, isValid } = normalizePhone(phone);
    if (!isValid || !normalized) {
      return null;
    }

    return `+${normalized}`;
  }
}
