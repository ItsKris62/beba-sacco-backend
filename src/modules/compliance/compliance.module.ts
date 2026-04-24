import { Module } from '@nestjs/common';
import { ComplianceService } from './compliance.service';
import { ComplianceController } from './compliance.controller';
import { ConsentService } from './consent.service';
import { ConsentController } from './consent.controller';
import { FinancialModule } from '../financial/financial.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [FinancialModule, AuditModule],
  providers: [ComplianceService, ConsentService],
  controllers: [ComplianceController, ConsentController],
  exports: [ComplianceService, ConsentService],
})
export class ComplianceModule {}
