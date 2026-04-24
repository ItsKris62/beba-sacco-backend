import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, CrbExportJobPayload } from '../queue.constants';
import { CrbService } from '../../integrations/crb/crb.service';

@Processor(QUEUE_NAMES.CRB_EXPORT)
export class CrbExportProcessor extends WorkerHost {
  private readonly logger = new Logger(CrbExportProcessor.name);

  constructor(private readonly crb: CrbService) {
    super();
  }

  async process(job: Job<CrbExportJobPayload>): Promise<void> {
    this.logger.log(`Processing CRB export: reportId=${job.data.reportId}`);
    await this.crb.processExport(job.data.reportId);
  }
}
