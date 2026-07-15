import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { StorageModule } from '../storage/storage.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { DocumentsService } from './documents.service';
import { DocumentCleanupProcessor } from './processors/document-cleanup.processor';
import { isWorkerRuntime } from '../queue/worker-runtime';
import { AlertsService } from '../alerts/alerts.service';
import { PlunkService } from '../../common/services/plunk.service';

const DOCUMENT_WORKER_PROVIDERS = isWorkerRuntime() ? [DocumentCleanupProcessor] : [];

@Module({
  imports: [
    AuditModule,
    StorageModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.DOCUMENT_CLEANUP }),
    BullModule.registerQueue({ name: QUEUE_NAMES.KYC_REVIEW }),
  ],
  providers: [
    DocumentsService,
    ...DOCUMENT_WORKER_PROVIDERS,
    PrismaService,
    PlunkService,
    AlertsService,
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
