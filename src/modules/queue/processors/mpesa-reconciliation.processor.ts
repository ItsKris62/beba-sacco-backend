import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, MpesaReconciliationJobPayload } from '../queue.constants';
import { ReconciliationService } from '../../financial/reconciliation.service';

/**
 * Runs the daily M-Pesa reconciliation engine.
 * Scheduled: `5 0 * * *` (00:05 daily – 5 min after accrual to avoid contention).
 */
@Processor(QUEUE_NAMES.MPESA_RECONCILIATION, { concurrency: 2 })
export class MpesaReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(MpesaReconciliationProcessor.name);

  constructor(private readonly reconciliation: ReconciliationService) {
    super();
  }

  async process(job: Job<MpesaReconciliationJobPayload>) {
    const { tenantId, settlementDate } = job.data;
    this.logger.log(`Running M-Pesa reconciliation: tenant=${tenantId} date=${settlementDate}`);

    const report = await this.reconciliation.runReconciliation(tenantId, settlementDate);

    if (report.mismatches.length > 0) {
      this.logger.warn(
        `Recon mismatches found: tenant=${tenantId} count=${report.mismatches.length}`,
      );
    }

    return report;
  }
}
