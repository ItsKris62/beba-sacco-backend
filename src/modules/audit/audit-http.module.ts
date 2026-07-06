import { Module } from '@nestjs/common';
import { AuditModule } from './audit.module';
import { AdminAuditController, AuditController } from './audit.controller';

@Module({
  imports: [AuditModule],
  controllers: [AuditController, AdminAuditController],
  exports: [AuditModule],
})
export class AuditHttpModule {}