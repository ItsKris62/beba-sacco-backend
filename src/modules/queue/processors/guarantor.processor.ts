import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  GUARANTOR_VALIDATION_QUEUE_JOB,
  GuarantorValidationJobPayload,
  QUEUE_NAMES,
} from '../queue.constants';

@Processor(QUEUE_NAMES.GUARANTOR_VALIDATION, { concurrency: 5 })
export class GuarantorProcessor extends WorkerHost {
  private readonly logger = new Logger(GuarantorProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.GUARANTOR_VALIDATION_DLQ)
    private readonly dlq: Queue<GuarantorValidationJobPayload>,
  ) {
    super();
  }

  async process(job: Job<GuarantorValidationJobPayload>): Promise<void> {
    if (job.name !== GUARANTOR_VALIDATION_QUEUE_JOB) return;

    const { guarantorId, loanId, tenantId, memberId, status } = job.data;
    const guarantor = await this.prisma.loanGuarantor.findFirst({
      where: { id: guarantorId, loanId, tenantId, memberId },
      select: { id: true, status: true },
    });

    if (!guarantor) {
      throw new Error(`LoanGuarantor ${guarantorId} not found for tenant ${tenantId}`);
    }

    await this.prisma.auditLog.create({
      data: {
        tenantId,
        action: 'GUARANTOR.ASYNC_VALIDATED',
        entityType: 'LoanGuarantor',
        entityId: guarantorId,
        metadata: { loanId, memberId, status },
      },
    });

    this.logger.log(`Validated guarantor ${guarantorId} status=${status}`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<GuarantorValidationJobPayload>, error: Error): Promise<void> {
    await this.dlq.add('failed', job.data, {
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: { age: 86400, count: 50 },
    });
    this.logger.error(`LoanGuarantor validation failed job=${job.id}: ${error.message}`, error.stack);
  }
}
