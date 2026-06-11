import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES, SmsJobPayload } from '../queue/queue.constants';
import { normalizePhone } from '../data-import/utils/phone-normalizer';
import { maskPhone } from '../mpesa/utils/mpesa.utils';

// africastalking ships without TypeScript declarations
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AfricasTalking = require('africastalking') as (opts: {
  apiKey: string;
  username: string;
}) => {
  SMS: {
    send: (params: {
      to: string[];
      message: string;
      from?: string;
    }) => Promise<{ SMSMessageData?: { Recipients?: Array<{ status: string; number: string }> } }>;
  };
};

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectQueue(QUEUE_NAMES.SMS)
    private readonly smsQueue: Queue<SmsJobPayload>,
  ) {}

  /**
   * Enqueue an SMS job for asynchronous delivery via BullMQ.
   */
  async enqueueSms(payload: SmsJobPayload, ctx: string): Promise<void> {
    try {
      await this.smsQueue.add('send', payload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });
    } catch (err: unknown) {
      this.logger.error(
        `[SmsQueue] enqueue failed [${ctx}]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Send an SMS directly via Africa's Talking (called by SmsProcessor).
   * Phone numbers are formatted to E.164 (+254XXXXXXXXX) before dispatch.
   */
  async sendSms(phone: string, message: string): Promise<boolean> {
    const formattedPhone = this.formatPhoneE164(phone);
    if (!formattedPhone) {
      this.logger.warn('SMS skipped — phone could not be normalized to E.164');
      return false;
    }

    const username = this.configService.get<string>('app.africasTalking.username');
    const apiKey = this.configService.get<string>('app.africasTalking.apiKey');
    const senderId = this.configService.get<string>('app.africasTalking.senderId');

    if (!username || !apiKey) {
      this.logger.warn(
        `SMS not sent to ${maskPhone(formattedPhone.replace(/^\+/, ''))} — Africa's Talking credentials missing`,
      );
      return false;
    }

    try {
      const client = AfricasTalking({ username, apiKey });
      const result = await client.SMS.send({
        to: [formattedPhone],
        message,
        ...(senderId ? { from: senderId } : {}),
      });

      const recipients = result?.SMSMessageData?.Recipients ?? [];
      const delivered = recipients.some((r) => r.status === 'Success');
      if (!delivered) {
        this.logger.warn(
          `SMS delivery uncertain for ${maskPhone(formattedPhone.replace(/^\+/, ''))}: ${JSON.stringify(recipients)}`,
        );
      }
      return delivered;
    } catch (err: unknown) {
      this.logger.error(
        `SMS send failed for ${maskPhone(formattedPhone.replace(/^\+/, ''))}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Format a Kenyan phone number to E.164 with leading '+' for Africa's Talking.
   * Example: 254712345678 → +254712345678
   */
  formatPhoneE164(phone: string): string | null {
    const { normalized, isValid } = normalizePhone(phone);
    if (!isValid || !normalized) {
      return null;
    }
    return `+${normalized}`;
  }
}
