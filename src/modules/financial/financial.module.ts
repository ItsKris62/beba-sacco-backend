import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { FinancialService } from './financial.service';
import { ReconciliationService } from './reconciliation.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CommonServicesModule } from '../../common/services/common-services.module';

@Module({
  imports: [
    CommonServicesModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.INTEREST_ACCRUAL },
      { name: QUEUE_NAMES.REPAYMENT_SCHEDULE },
      { name: QUEUE_NAMES.MPESA_RECONCILIATION },
      { name: QUEUE_NAMES.LEDGER_INTEGRITY },
    ),
  ],
  providers: [PrismaService, FinancialService, ReconciliationService],
  exports: [FinancialService, ReconciliationService, BullModule],
})
export class FinancialModule {}
