import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../../queue/queue.constants';

@Injectable()
export class StkExpiryScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(StkExpiryScheduler.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.MPESA_STK_EXPIRY)
    private readonly stkExpiryQueue: Queue<Record<string, never>>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV !== 'production') {
      return;
    }

    await this.stkExpiryQueue.add(
      'stk-expiry-sweep',
      {},
      {
        jobId: 'stk-expiry-scheduler',
        repeat: { every: 5 * 60 * 1000 },
        removeOnComplete: true,
        removeOnFail: { count: 100 },
      },
    );

    this.logger.log('Scheduled STK expiry sweep every 5 minutes');
  }
}
