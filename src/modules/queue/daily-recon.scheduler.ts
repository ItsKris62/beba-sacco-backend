import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from './queue.constants';

@Injectable()
export class DailyReconScheduler implements OnModuleInit {
  private readonly logger = new Logger(DailyReconScheduler.name);

  constructor(@InjectQueue(QUEUE_NAMES.MPESA_RECONCILIATION) private readonly reconQueue: Queue) {}

  async onModuleInit() {
    if (process.env.ENABLE_DAILY_RECON !== 'true') {
      this.logger.log('Daily recon report scheduler is disabled via environment.');
      return;
    }

    await this.reconQueue.add(
      'daily-recon',
      { generatedAt: Date.now() },
      {
        repeat: { pattern: '0 2 * * *', tz: 'Africa/Nairobi' }, // 2 AM EAT
        jobId: 'daily-recon-job-v1', // deterministic ID prevents duplicate registrations
      }
    );
    this.logger.log('Scheduled daily-recon repeatable job for 2 AM EAT');
  }
}
