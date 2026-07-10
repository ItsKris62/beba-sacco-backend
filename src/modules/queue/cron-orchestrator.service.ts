import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TenantStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { InterestAccrualJobPayload, QUEUE_NAMES } from './queue.constants';

const EAT_TIME_ZONE = 'Africa/Nairobi';

/**
 * Fans out one INTEREST_ACCRUAL job per active tenant, daily at midnight EAT.
 *
 * Interest/penalty accrual and DEFAULTED classification (staging -> NPL at
 * 90+ arrears days -> Loan.status = DEFAULTED) happen inside
 * FinancialService.runDailyAccrual, invoked per-tenant by
 * InterestAccrualProcessor. Each tenant gets its own BullMQ job (with its own
 * retries), so one tenant failing never blocks or delays another tenant's run.
 */
@Injectable()
export class CronOrchestratorService {
  private readonly logger = new Logger(CronOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.INTEREST_ACCRUAL)
    private readonly accrualQueue: Queue<InterestAccrualJobPayload>,
  ) {}

  @Cron('0 0 * * *', { timeZone: EAT_TIME_ZONE })
  async runDailyAccrualFanout(): Promise<void> {
    if (process.env.ENABLE_PHASE3_DAILY_JOBS !== 'true') {
      this.logger.log(
        'Daily accrual fan-out is disabled via environment (ENABLE_PHASE3_DAILY_JOBS).',
      );
      return;
    }

    const accrualDate = new Date().toISOString().slice(0, 10);
    const tenants = await this.prisma.tenant.findMany({
      where: { status: TenantStatus.ACTIVE },
      select: { id: true },
    });

    let enqueued = 0;
    for (const tenant of tenants) {
      try {
        await this.accrualQueue.add(
          'accrue-tenant',
          { tenantId: tenant.id, accrualDate },
          {
            jobId: `interest-accrual.${tenant.id}.${accrualDate}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 10000 },
            removeOnComplete: true,
            removeOnFail: { age: 604800, count: 50 },
          },
        );
        enqueued++;
      } catch (err) {
        // Enqueue failures (e.g. a transient Redis blip) must never stop the
        // remaining tenants from being scheduled.
        this.logger.error(`Failed to enqueue interest accrual for tenant=${tenant.id}`, err);
      }
    }

    this.logger.log(
      `Interest accrual fan-out complete: enqueued ${enqueued}/${tenants.length} tenant job(s) for ${accrualDate}.`,
    );
  }
}
