import { Module } from '@nestjs/common';
import { StatementController } from './statement.controller';
import { StatementService } from './statement.service';
import { ComplianceModule } from '../compliance/compliance.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [ComplianceModule, AuditModule],
  controllers: [StatementController],
  providers: [StatementService],
  exports: [StatementService],
})
export class StatementsModule {}
