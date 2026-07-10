import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  APPLY_DAILY_PENALTIES_JOB,
  PROCESS_GUARANTOR_FORFEITURE_JOB,
  QUEUE_NAMES,
} from '../../modules/queue/queue.constants';

const EAT_TIME_ZONE = 'Africa/Nairobi';

@Injectable()
export class DailyJobsScheduler implements OnModuleInit {
  private readonly logger = new Logger(DailyJobsScheduler.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.LOAN_PENALTY_QUEUE)
    private readonly penaltiesQueue: Queue,
    @InjectQueue(QUEUE_NAMES.GUARANTOR_DEFAULT_OFFSET_QUEUE)
    private readonly forfeitureQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.ENABLE_PHASE3_DAILY_JOBS !== 'true') {
      this.logger.log('Phase 3 daily job scheduler is disabled via environment.');
      return;
    }

    await Promise.all([
      this.penaltiesQueue.add(
        APPLY_DAILY_PENALTIES_JOB,
        { source: 'daily-repeatable-scheduler' },
        {
          repeat: { pattern: '0 0 * * *', tz: EAT_TIME_ZONE },
          // BullMQ rejects ':' in custom job IDs — see audit-event.service.ts
          // for the full explanation. This one is worse than most: a rejected
          // jobId here means the repeatable cron registration itself throws,
          // so daily penalty application never gets scheduled at all.
          jobId: 'apply-daily-penalties.daily-midnight-eat',
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
          removeOnComplete: true,
          removeOnFail: { age: 604800, count: 10 },
        },
      ),
      this.forfeitureQueue.add(
        PROCESS_GUARANTOR_FORFEITURE_JOB,
        { source: 'daily-repeatable-scheduler' },
        {
          repeat: { pattern: '0 0 * * *', tz: EAT_TIME_ZONE },
          jobId: 'process-guarantor-forfeiture.daily-midnight-eat',
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
          removeOnComplete: true,
          removeOnFail: { age: 604800, count: 10 },
        },
      ),
    ]);

    this.logger.log('Registered Phase 3 daily repeatable jobs for midnight EAT.');
  }
}

