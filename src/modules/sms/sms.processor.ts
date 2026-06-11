import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, SmsJobPayload } from '../queue/queue.constants';
import { SmsService } from './sms.service';
import { maskPhone } from '../mpesa/utils/mpesa.utils';

/**
 * SMS Queue Processor
 *
 * Processes outbound SMS jobs via Africa's Talking.
 * Mirrors the EmailProcessor pattern — enqueue in the service, deliver here.
 */
@Processor(QUEUE_NAMES.SMS, { concurrency: 3 })
export class SmsProcessor extends WorkerHost {
  private readonly logger = new Logger(SmsProcessor.name);

  constructor(private readonly smsService: SmsService) {
    super();
  }

  async process(job: Job<SmsJobPayload>): Promise<void> {
    const { phone, message } = job.data;
    const masked = maskPhone(phone.replace(/^\+/, ''));
    this.logger.log(`Processing SMS job ${job.id} to=${masked}`);

    const sent = await this.smsService.sendSms(phone, message);
    if (!sent) {
      this.logger.warn(`SMS not delivered for job ${job.id} to=${masked}`);
    }
  }
}
