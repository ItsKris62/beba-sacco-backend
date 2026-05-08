import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { FinancialModule } from '../financial/financial.module';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * AccountingModule
 *
 * Exposes admin-facing accounting endpoints:
 *   GET /admin/accounting/ledgers        — daily ledger grouped by account
 *   GET /admin/accounting/reconciliation — M-Pesa recon report + RECON_PENDING list
 *   GET /admin/accounting/reports        — account book, loan book, M-Pesa volume summary
 *
 * Imports FinancialModule to access ReconciliationService (already exported there).
 * No new GL/journal models — aggregates over existing Transaction + Account + Loan tables.
 */
@Module({
  imports: [FinancialModule],
  controllers: [AccountingController],
  providers: [AccountingService, PrismaService],
})
export class AccountingModule {}
