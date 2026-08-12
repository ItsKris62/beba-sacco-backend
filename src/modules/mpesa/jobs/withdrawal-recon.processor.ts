import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AuditService } from '../../audit/audit.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import { WithdrawalReconciliationService } from '../withdrawal-reconciliation.service';

/**
 * Reconciliation sweep for non-terminal FOSA withdrawal B2C rows.
 *
 * This worker never re-debits, never blindly resends an ambiguous provider call,
 * never mutates Account.balance directly, and never auto-refunds an unknown
 * provider outcome. It delegates provider status refresh, anomaly surfacing,
 * bounded retry/backoff, metrics, and audit history to WithdrawalReconciliationService.
 */
@Processor(QUEUE_NAMES.MPESA_WITHDRAWAL_RECON, { concurrency: 2 })
export class WithdrawalReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(WithdrawalReconciliationProcessor.name);

  constructor(
    private readonly reconciliation: WithdrawalReconciliationService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  async process(job: Job<Record<string, never>>): Promise<void> {
    const result = await this.reconciliation.runAutomatedSweep(job.id);
    this.logger.log(
      `Withdrawal reconciliation sweep | job=${job.id} reconciled=${result.reconciled} ` +
        `staleOutbox=${result.staleOutbox} anomalies=${result.anomalies}`,
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<Record<string, never>>): Promise<void> {
    await this.audit
      .create({
        tenantId: 'SYSTEM',
        actorId: 'SYSTEM',
        action: 'MPESA.WITHDRAWAL.RECON_DLQ',
        entityType: 'QueueJob',
        entityId: String(job.id ?? 'unknown'),
        newValue: {
          queue: QUEUE_NAMES.MPESA_WITHDRAWAL_RECON,
          failedReason: job.failedReason,
        },
        metadata: {
          attemptsMade: job.attemptsMade ?? 0,
          failedAt: new Date().toISOString(),
        },
        requestId: `audit.MPESA.WITHDRAWAL.RECON_DLQ.SYSTEM.${job.id ?? 'unknown'}`,
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Failed to audit withdrawal recon DLQ job=${job.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
  }
}
