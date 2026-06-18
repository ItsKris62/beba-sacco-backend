import { Inject, Injectable } from '@nestjs/common';
import { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';

type RedisClient = {
  setnx: (key: string, value: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
};

type DailyJobMetrics = {
  jobSpilloverTotal: { inc: (labels: Record<string, string>) => void };
  accrualSkippedTotal: { inc: (labels: Record<string, string>) => void };
  jobDurationSeconds: { startTimer: (labels: Record<string, string>) => () => void };
};

@Injectable()
export class DailyJobsProcessor {
  constructor(
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    @Inject(MetricsService) private readonly metrics: DailyJobMetrics,
    @Inject('REDIS_CLIENT') private readonly redis: RedisClient,
  ) {
    this.logger.setContext(DailyJobsProcessor.name);
  }

  async process(job: Job<{ correlationId?: string }>): Promise<void> {
    const eatHour = (new Date().getUTCHours() + 3) % 24;
    if (eatHour >= 5 && eatHour < 22) {
      this.metrics.jobSpilloverTotal.inc({ job: job.name });
      this.logger.warn({ job: job.name }, 'Daily job skipped outside execution window');
      return;
    }

    const stopTimer = this.metrics.jobDurationSeconds.startTimer({ job: job.name });
    try {
      const take = 100;
      let cursor: string | undefined;
      for (;;) {
        const tenants = await this.prisma.tenant.findMany({
          take,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          orderBy: { id: 'asc' },
          select: { id: true },
        });
        if (tenants.length === 0) break;

        for (const tenant of tenants) {
          const jobKey = job.name.toLowerCase().replace(/^daily_/, '');
          const lockKey = `${jobKey}:${tenant.id}:${new Date().toISOString().slice(0, 10)}`;
          const acquired = await this.redis.setnx(lockKey, '1');
          if (!acquired) {
            this.metrics.accrualSkippedTotal.inc({ tenantId: tenant.id, reason: 'LOCKED' });
            continue;
          }
          await this.redis.expire(lockKey, 60 * 60 * 6);
        }

        cursor = tenants[tenants.length - 1]?.id;
      }
    } finally {
      stopTimer();
    }
  }
}
