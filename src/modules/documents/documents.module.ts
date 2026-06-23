import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { StorageModule } from '../storage/storage.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { AdminDocumentsController } from './admin-documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentCleanupProcessor } from './processors/document-cleanup.processor';
import { isWorkerRuntime } from '../queue/worker-runtime';

const DOCUMENT_WORKER_PROVIDERS = isWorkerRuntime() ? [DocumentCleanupProcessor] : [];

@Module({
  imports: [
    AuditModule,
    StorageModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.DOCUMENT_CLEANUP }),
    BullModule.registerQueue({ name: QUEUE_NAMES.KYC_REVIEW }),
  ],
  controllers: [AdminDocumentsController],
  providers: [DocumentsService, ...DOCUMENT_WORKER_PROVIDERS, PrismaService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
