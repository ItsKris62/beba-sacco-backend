import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuditService } from './audit.service';
import { AuditEventService } from './audit-event.service';
import { AuditChainService } from './audit.chain.service';
import { AuditMaskerService } from './audit.masker.service';
import { PrismaAuditMiddlewareService } from './prisma-audit-middleware.service';
import { AdminAuditController, AuditController } from './audit.controller';
import { SasraValidatorService } from './sasra-validator.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AuditRetentionProcessor,
  AUDIT_RETENTION_QUEUE,
} from './processors/audit-retention.processor';
import { QUEUE_NAMES } from '../queue/queue.constants';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: AUDIT_RETENTION_QUEUE },
      { name: QUEUE_NAMES.AUDIT_PERSIST },
      { name: QUEUE_NAMES.AUDIT_PERSIST_DLQ },
    ),
  ],
  controllers: [AuditController, AdminAuditController],
  providers: [
    AuditService,
    AuditEventService,
    AuditChainService,
    AuditMaskerService,
    PrismaAuditMiddlewareService,
    SasraValidatorService,
    PrismaService,
    AuditRetentionProcessor,
  ],
  exports: [AuditService, AuditEventService, AuditChainService, AuditMaskerService, SasraValidatorService],
})
export class AuditModule {}
