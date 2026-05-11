import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DocumentsService } from '../documents.service';
import { DOCUMENT_ORPHAN_CLEANUP_JOB, QUEUE_NAMES } from '../../queue/queue.constants';

@Processor(QUEUE_NAMES.DOCUMENT_CLEANUP)
export class DocumentCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentCleanupProcessor.name);

  constructor(private readonly documents: DocumentsService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== DOCUMENT_ORPHAN_CLEANUP_JOB) {
      this.logger.warn(`Unknown document cleanup job: ${job.name}`);
      return;
    }

    const result = await this.documents.cleanupExpiredUploads();
    this.logger.debug(`Document cleanup completed: ${result.deleted} expired uploads deleted`);
  }
}
