import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { SasraValidatorService } from './sasra-validator.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AuditRetentionProcessor,
  AUDIT_RETENTION_QUEUE,
} from './processors/audit-retention.processor';

@Module({
  imports: [BullModule.registerQueue({ name: AUDIT_RETENTION_QUEUE })],
  controllers: [AuditController],
  providers: [AuditService, SasraValidatorService, PrismaService, AuditRetentionProcessor],
  exports: [AuditService, SasraValidatorService],
})
export class AuditModule {}
