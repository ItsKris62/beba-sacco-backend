import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { FinancialService } from './financial.service';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUE_NAMES.INTEREST_ACCRUAL },
      { name: QUEUE_NAMES.REPAYMENT_SCHEDULE },
      { name: QUEUE_NAMES.MPESA_RECONCILIATION },
      { name: QUEUE_NAMES.LEDGER_INTEGRITY },
    ),
  ],
  providers: [FinancialService, ReconciliationService],
  exports: [FinancialService, ReconciliationService, BullModule],
})
export class FinancialModule {}
