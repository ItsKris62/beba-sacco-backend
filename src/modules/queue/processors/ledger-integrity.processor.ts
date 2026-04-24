import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, LedgerIntegrityJobPayload } from '../queue.constants';
import { FinancialService } from '../../financial/financial.service';

/**
 * Runs the hourly ledger integrity check.
 * Scheduled: `0 * * * *` (every hour).
 *
 * If drift is detected, the result is logged as an error for alerting rules to pick up.
 * Downstream: Alertmanager should watch for ERROR-level ledger drift logs.
 */
@Processor(QUEUE_NAMES.LEDGER_INTEGRITY, { concurrency: 2 })
export class LedgerIntegrityProcessor extends WorkerHost {
  private readonly logger = new Logger(LedgerIntegrityProcessor.name);

  constructor(private readonly financial: FinancialService) {
    super();
  }

  async process(job: Job<LedgerIntegrityJobPayload>) {
    const { tenantId } = job.data;
    this.logger.debug(`Ledger integrity check: tenant=${tenantId}`);

    const result = await this.financial.runLedgerIntegrityCheck(tenantId);

    if (result.driftCount > 0) {
      // Emit structured error log – Alertmanager loki rule will catch this
      this.logger.error('LEDGER_DRIFT_DETECTED', {
        tenantId,
        driftCount: result.driftCount,
        drifts: result.drifts,
      });
    }

    return result;
  }
}
