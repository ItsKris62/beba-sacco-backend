import { Module } from '@nestjs/common';
import { ComplianceService } from './compliance.service';
import { ComplianceController } from './compliance.controller';
import { FinancialModule } from '../financial/financial.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [FinancialModule, AuditModule],
  providers: [ComplianceService],
  controllers: [ComplianceController],
  exports: [ComplianceService],
})
export class ComplianceModule {}
