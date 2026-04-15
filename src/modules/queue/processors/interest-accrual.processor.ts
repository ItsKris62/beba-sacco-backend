import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, InterestAccrualJobPayload } from '../queue.constants';
import { FinancialService } from '../../financial/financial.service';

/**
 * Processes daily interest & penalty accrual jobs.
 *
 * Scheduled by: BullMQ repeatable job `0 0 * * *` (midnight daily).
 * One job per tenant is enqueued; this processor runs them concurrently.
 */
@Processor(QUEUE_NAMES.INTEREST_ACCRUAL, { concurrency: 3 })
export class InterestAccrualProcessor extends WorkerHost {
  private readonly logger = new Logger(InterestAccrualProcessor.name);

  constructor(private readonly financial: FinancialService) {
    super();
  }

  async process(job: Job<InterestAccrualJobPayload>): Promise<{ processed: number; skipped: number }> {
    const { tenantId, accrualDate } = job.data;
    this.logger.log(`Running interest accrual: tenant=${tenantId} date=${accrualDate}`);

    const result = await this.financial.runDailyAccrual(tenantId, accrualDate);

    this.logger.log(
      `Accrual done: tenant=${tenantId} processed=${result.processed} skipped=${result.skipped}`,
    );
    return result;
  }
}
