import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, SmsJobPayload, TEMP_PASSWORD_PLACEHOLDER } from '../queue/queue.constants';
import { SmsService } from './sms.service';
import { maskPhone } from '../mpesa/utils/mpesa.utils';
import { EncryptionService, EncryptedPayload } from '../zero-trust/encryption/encryption.service';

/**
 * SMS Queue Processor
 *
 * Processes outbound SMS jobs via Africa's Talking.
 * Mirrors the EmailProcessor pattern — enqueue in the service, deliver here.
 */
@Processor(QUEUE_NAMES.SMS, { concurrency: 3 })
export class SmsProcessor extends WorkerHost {
  private readonly logger = new Logger(SmsProcessor.name);

  constructor(
    private readonly smsService: SmsService,
    private readonly encryption: EncryptionService,
  ) {
    super();
  }

  async process(job: Job<SmsJobPayload>): Promise<void> {
    const { phone, type } = job.data;
    const masked = maskPhone(phone.replace(/^\+/, ''));
    this.logger.log(`Processing SMS job ${job.id} type=${type} to=${masked}`);

    // TEMP_PASSWORD jobs never carry plaintext in the Redis-backed payload — the
    // message holds TEMP_PASSWORD_PLACEHOLDER, decrypted and substituted here,
    // immediately before send, so the plaintext only ever exists in memory.
    let message = job.data.message;
    if (job.data.encryptedPayload && job.data.tenantId) {
      const payload = JSON.parse(job.data.encryptedPayload) as EncryptedPayload;
      const decrypted = await this.encryption.decrypt(payload, job.data.tenantId);
      message = message.replace(TEMP_PASSWORD_PLACEHOLDER, decrypted);
    }

    const sent = await this.smsService.sendSms(phone, message);
    if (!sent) {
      this.logger.warn(`SMS not delivered for job ${job.id} to=${masked}`);
    }
  }
}

