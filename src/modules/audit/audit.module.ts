import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuditService } from './audit.service';
import { AuditEventService } from './audit-event.service';
import { AuditChainService } from './audit.chain.service';
import { AuditMaskerService } from './audit.masker.service';
import { PrismaAuditMiddlewareService } from './prisma-audit-middleware.service';
import { SasraValidatorService } from './sasra-validator.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AuditRetentionProcessor,
  AUDIT_RETENTION_QUEUE,
} from './processors/audit-retention.processor';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { isWorkerRuntime } from '../queue/worker-runtime';

const AUDIT_WORKER_PROVIDERS = isWorkerRuntime() ? [AuditRetentionProcessor] : [];

@Module({
  imports: [
    BullModule.registerQueue(
      { name: AUDIT_RETENTION_QUEUE },
      { name: QUEUE_NAMES.AUDIT_PERSIST },
      { name: QUEUE_NAMES.AUDIT_PERSIST_DLQ },
    ),
  ],
  providers: [
    AuditService,
    AuditEventService,
    AuditChainService,
    AuditMaskerService,
    PrismaAuditMiddlewareService,
    SasraValidatorService,
    PrismaService,
    ...AUDIT_WORKER_PROVIDERS,
  ],
  exports: [AuditService, AuditEventService, AuditChainService, AuditMaskerService, SasraValidatorService],
})
export class AuditModule {}
