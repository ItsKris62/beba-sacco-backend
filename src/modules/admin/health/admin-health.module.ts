import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AdminHealthController } from './admin-health.controller';
import { AdminHealthService } from './admin-health.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';

const ENABLE_ADMIN_HEALTH_QUEUES =
  process.env.NODE_ENV !== 'production' || process.env.ENABLE_BULL_BOARD === 'true';

@Module({
  imports: ENABLE_ADMIN_HEALTH_QUEUES
    ? [
        BullModule.registerQueue(
          { name: QUEUE_NAMES.EMAIL },
          { name: QUEUE_NAMES.AUDIT_LOG },
          { name: QUEUE_NAMES.LOAN_DISBURSE },
          { name: QUEUE_NAMES.MPESA_CALLBACK },
          { name: QUEUE_NAMES.MPESA_DISBURSEMENT },
          { name: QUEUE_NAMES.MPESA_CALLBACK_DLQ },
          { name: QUEUE_NAMES.INTEREST_ACCRUAL },
          { name: QUEUE_NAMES.REPAYMENT_SCHEDULE },
          { name: QUEUE_NAMES.LEDGER_INTEGRITY },
          { name: QUEUE_NAMES.OUTBOUND_WEBHOOK },
        ),
      ]
    : [],
  controllers: [AdminHealthController],
  providers: [AdminHealthService, PrismaService],
  exports: [AdminHealthService],
})
export class AdminHealthModule {}
