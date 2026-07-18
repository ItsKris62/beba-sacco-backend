import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  PROCESS_GUARANTOR_FORFEITURE_JOB,
  QUEUE_NAMES,
} from '../../modules/queue/queue.constants';

const EAT_TIME_ZONE = 'Africa/Nairobi';

@Injectable()
export class DailyJobsScheduler implements OnModuleInit {
  private readonly logger = new Logger(DailyJobsScheduler.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.GUARANTOR_DEFAULT_OFFSET_QUEUE)
    private readonly forfeitureQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.ENABLE_PHASE3_DAILY_JOBS !== 'true') {
      this.logger.log('Phase 3 daily job scheduler is disabled via environment.');
      return;
    }

    // NOTE (Phase 2 audit fix): the APPLY_DAILY_PENALTIES_JOB repeatable
    // registration that used to live here has been removed. It ran on this
    // same midnight-EAT cron as CronOrchestratorService.runDailyAccrualFanout()
    // (-> FinancialService.runDailyAccrual()) and both independently wrote
    // Loan.arrearsAmount — one incrementing per overdue installment, the other
    // blanket-overwriting from Loan.dueDate — a genuine race, whichever ran
    // last each night clobbered the other. That logic (overdue-installment
    // penalty accrual + the arrears/staging rollup it feeds) now lives solely
    // in FinancialService.applyOverdueInstallmentsAndArrears(), called from
    // inside runDailyAccrual()'s own per-loan transaction. LoanPenaltyProcessor
    // itself is left in place (see its class-level comment) but is no longer
    // scheduled anywhere, so it never runs in production.
    await Promise.all([
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

