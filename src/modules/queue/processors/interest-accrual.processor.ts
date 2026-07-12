import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import {
  CAPTURE_LOAN_ARREARS_SNAPSHOT_JOB,
  InterestAccrualJobPayload,
  LoanArrearsSnapshotJobPayload,
  QUEUE_NAMES,
} from '../queue.constants';
import { FinancialService } from '../../financial/financial.service';

const EAT_TIME_ZONE = 'Africa/Nairobi';

function getEatBusinessDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: EAT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

/**
 * Processes daily interest & penalty accrual jobs.
 *
 * Scheduled by: BullMQ repeatable job `0 0 * * *` (midnight daily).
 * One job per tenant is enqueued; this processor runs them concurrently.
 */
@Processor(QUEUE_NAMES.INTEREST_ACCRUAL, { concurrency: 3 })
export class InterestAccrualProcessor extends WorkerHost {
  private readonly logger = new Logger(InterestAccrualProcessor.name);

  constructor(
    private readonly financial: FinancialService,
    @InjectQueue(QUEUE_NAMES.LOAN_ARREARS_SNAPSHOT)
    private readonly arrearsSnapshotQueue: Queue<LoanArrearsSnapshotJobPayload>,
  ) {
    super();
  }

  async process(job: Job<InterestAccrualJobPayload>): Promise<{ processed: number; skipped: number }> {
    const { tenantId, accrualDate } = job.data;
    this.logger.log(`Running interest accrual: tenant=${tenantId} date=${accrualDate}`);

    const result = await this.financial.runDailyAccrual(tenantId, accrualDate);

    this.logger.log(
      `Accrual done: tenant=${tenantId} processed=${result.processed} skipped=${result.skipped}`,
    );
    await this.enqueueArrearsSnapshot(tenantId, job.id?.toString());
    return result;
  }

  private async enqueueArrearsSnapshot(tenantId: string, accrualJobId?: string): Promise<void> {
    if (process.env.ENABLE_LOAN_ARREARS_SNAPSHOT_JOB !== 'true') {
      return;
    }

    const snapshotDate = getEatBusinessDate();
    try {
      await this.arrearsSnapshotQueue.add(
        CAPTURE_LOAN_ARREARS_SNAPSHOT_JOB,
        {
          tenantId,
          snapshotDate,
          source: 'interest-accrual-complete',
          accrualJobId,
        },
        {
          jobId: `loan-arrears-snapshot.${tenantId}.${snapshotDate}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
          removeOnComplete: true,
          removeOnFail: { age: 604800, count: 50 },
        },
      );
      this.logger.log(`Queued arrears snapshot: tenant=${tenantId} date=${snapshotDate}`);
    } catch (err) {
      this.logger.error(`Failed to enqueue arrears snapshot for tenant=${tenantId}`, err);
    }
  }
}
