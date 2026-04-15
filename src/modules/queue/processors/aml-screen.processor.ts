import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, AmlScreenJobPayload } from '../queue.constants';
import { AmlService } from '../../integrations/aml/aml.service';

@Processor(QUEUE_NAMES.AML_SCREEN)
export class AmlScreenProcessor extends WorkerHost {
  private readonly logger = new Logger(AmlScreenProcessor.name);

  constructor(private readonly aml: AmlService) {
    super();
  }

  async process(job: Job<AmlScreenJobPayload>): Promise<void> {
    this.logger.log(`Processing AML screening: screeningId=${job.data.screeningId}`);
    await this.aml.processScreening(job.data.screeningId);
  }
}
