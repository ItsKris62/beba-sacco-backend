import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { FinancialService } from './financial.service';
import { ReconciliationService } from './reconciliation.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CommonServicesModule } from '../../common/services/common-services.module';
import { AuditModule } from '../audit/audit.module';
import { LedgerService } from '../accounting/ledger.service';

// NOTE: does NOT import AccountingModule — AccountingModule itself imports
// FinancialModule (for ReconciliationService), so that would be a circular
// module dependency. LedgerService has no state beyond a small per-instance
// memoization cache (see resolveSystemActorId()), so providing it directly
// here (a second instance, same as AccountingModule's) is safe — all real
// state lives in PrismaService, which is a true singleton either way.
@Module({
  imports: [
    CommonServicesModule,
    AuditModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.INTEREST_ACCRUAL },
      { name: QUEUE_NAMES.REPAYMENT_SCHEDULE },
      { name: QUEUE_NAMES.MPESA_RECONCILIATION },
      { name: QUEUE_NAMES.LEDGER_INTEGRITY },
      { name: QUEUE_NAMES.AUDIT_LOG },
    ),
  ],
  providers: [PrismaService, FinancialService, ReconciliationService, LedgerService],
  exports: [FinancialService, ReconciliationService, BullModule],
})
export class FinancialModule {}
