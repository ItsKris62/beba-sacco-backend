import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, MpesaCallbackJobPayload } from '../queue.constants';
import { MpesaService, StkCallbackBody } from '../../mpesa/mpesa.service';

/**
 * Processes Daraja STK Push callback payloads queued by the webhook controller.
 * Decouples the Daraja HTTP response from the DB writes.
 *
 * Retry: 3 attempts, exponential backoff (2s, 4s, 8s).
 */
@Processor(QUEUE_NAMES.MPESA_CALLBACK, {
  concurrency: 5,
})
export class MpesaCallbackProcessor extends WorkerHost {
  private readonly logger = new Logger(MpesaCallbackProcessor.name);

  constructor(private readonly mpesaService: MpesaService) {
    super();
  }

  async process(job: Job<MpesaCallbackJobPayload>): Promise<void> {
    const { tenantId, callbackPayload } = job.data;
    this.logger.log(`Processing mpesa.callback job ${job.id} – tenant ${tenantId}`);

    try {
      await this.mpesaService.handleStkCallback(callbackPayload as unknown as StkCallbackBody);
      this.logger.log(`mpesa.callback job ${job.id} completed`);
    } catch (err: unknown) {
      this.logger.error(
        `mpesa.callback job ${job.id} failed`,
        err instanceof Error ? err.stack : err,
      );
      throw err; // BullMQ will retry based on queue config
    }
  }
}
