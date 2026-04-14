import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, LoanDisburseJobPayload } from '../queue.constants';
import { LoansService } from '../../loans/loans.service';

/**
 * Scheduled loan disbursement processor.
 * Handles async disbursement for loans that were approved with a future disburse date.
 *
 * Retry: 5 attempts, manual retry available in Bull dashboard.
 * Failed disbursements are critical — alert on failure in Phase 3.
 */
@Processor(QUEUE_NAMES.LOAN_DISBURSE, {
  concurrency: 2, // Low concurrency — money movements must serialize
})
export class LoanDisburseProcessor extends WorkerHost {
  private readonly logger = new Logger(LoanDisburseProcessor.name);

  constructor(private readonly loansService: LoansService) {
    super();
  }

  async process(job: Job<LoanDisburseJobPayload>): Promise<void> {
    const { loanId, tenantId, disbursedBy } = job.data;

    this.logger.log(`Processing loan disbursement job ${job.id} – loanId=${loanId}`);

    try {
      const result = await this.loansService.disburse(loanId, tenantId, disbursedBy);
      this.logger.log(
        `Loan ${loanId} disbursed via queue job ${job.id} – new balance ${result.newBalance}`,
      );
    } catch (err: unknown) {
      this.logger.error(
        `Loan disburse job ${job.id} failed for loanId=${loanId}`,
        err instanceof Error ? err.stack : err,
      );
      throw err; // Rethrow so BullMQ retries
    }
  }
}
