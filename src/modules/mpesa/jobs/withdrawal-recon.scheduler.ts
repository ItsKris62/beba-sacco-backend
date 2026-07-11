import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../../queue/queue.constants';

/**
 * Registers a repeatable sweep that catches FOSA withdrawals stuck in
 * RECON_PENDING (see MpesaB2cTimeoutProcessor) whose grace window has elapsed
 * without a Daraja callback ever landing. See WithdrawalReconciliationProcessor
 * for the actual auto-refund logic.
 */
@Injectable()
export class WithdrawalReconciliationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(WithdrawalReconciliationScheduler.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.MPESA_WITHDRAWAL_RECON)
    private readonly reconQueue: Queue<Record<string, never>>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV !== 'production') {
      return;
    }

    const repeatables = await this.reconQueue.getRepeatableJobs();
    const exists = repeatables.some((job) => job.id === 'withdrawal-recon-scheduler');
    if (exists) {
      this.logger.log('Withdrawal reconciliation scheduler already registered, skipping job creation');
      return;
    }

    await this.reconQueue.add(
      'withdrawal-recon-sweep',
      {},
      {
        jobId: 'withdrawal-recon-scheduler',
        repeat: { every: 10 * 60 * 1000 },
        removeOnComplete: true,
        removeOnFail: { count: 100 },
      },
    );

    this.logger.log('Scheduled withdrawal reconciliation sweep every 10 minutes');
  }
}
