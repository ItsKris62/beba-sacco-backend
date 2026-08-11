import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MpesaService } from '../mpesa.service';

@Injectable()
export class MpesaCallbackInboxScheduler {
  private readonly logger = new Logger(MpesaCallbackInboxScheduler.name);

  constructor(private readonly mpesaService: MpesaService) {}

  @Cron('*/1 * * * *', { name: 'mpesa-callback-inbox-dispatcher' })
  async dispatchPendingCallbacks(): Promise<void> {
    try {
      await this.mpesaService.dispatchPendingCallbackInbox();
    } catch (error) {
      this.logger.error(
        'M-Pesa callback inbox dispatcher failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
