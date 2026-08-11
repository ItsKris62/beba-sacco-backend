import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MpesaPayoutOutboxService } from '../mpesa-payout-outbox.service';

@Injectable()
export class MpesaPayoutOutboxScheduler {
  private readonly logger = new Logger(MpesaPayoutOutboxScheduler.name);

  constructor(private readonly payoutOutbox: MpesaPayoutOutboxService) {}

  @Cron('*/1 * * * *', { name: 'mpesa-payout-outbox-dispatcher' })
  async dispatchPendingPayoutIntents(): Promise<void> {
    try {
      await this.payoutOutbox.dispatchDueIntents();
    } catch (error) {
      this.logger.error(
        'M-Pesa payout outbox dispatcher failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
