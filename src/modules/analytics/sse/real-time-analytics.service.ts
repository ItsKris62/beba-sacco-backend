import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'events';
import { RedisService } from '../../../common/services/redis.service';
import { PrismaService } from '../../../prisma/prisma.service';
import Redis from 'ioredis';

export interface AnalyticsMetrics {
  tenantId: string;
  timestamp: string;
  totalDepositsToday: number;
  activeLoans: number;
  pendingApplications: number;
  nplRatio: number;
  liquidityRatio: number;
  memberCount: number;
}

/**
 * Real-Time Analytics Service – Phase 6
 *
 * Aggregates tenant-scoped metrics and broadcasts via:
 *  1. Node.js EventEmitter (in-process SSE)
 *  2. Redis PubSub (cross-instance sync for multi-pod deployments)
 *
 * Consumers subscribe via GET /admin/analytics/real-time (SSE endpoint).
 */
@Injectable()
export class RealTimeAnalyticsService implements OnModuleDestroy {
  private readonly logger = new Logger(RealTimeAnalyticsService.name);
  private readonly REDIS_CHANNEL = 'analytics:metrics';
  private readonly emitter = new EventEmitter();
  private subscriber: Redis | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    this.initRedisSubscriber();
  }

  private initRedisSubscriber(): void {
    try {
      this.subscriber = this.redis.createSubscriber();
      this.subscriber.subscribe(this.REDIS_CHANNEL, (err) => {
        if (err) {
          this.logger.error(`Redis subscribe error: ${err.message}`);
        }
      });

      this.subscriber.on('message', (_channel: string, message: string) => {
        try {
          const metrics = JSON.parse(message) as AnalyticsMetrics;
          this.emitter.emit('analytics.metrics', metrics);
        } catch {
          this.logger.warn('Failed to parse Redis analytics message');
        }
      });
    } catch (err) {
      this.logger.warn(`Redis PubSub init failed (degraded mode): ${(err as Error).message}`);
    }
  }

  /** Subscribe to metric events (used by SSE controller) */
  onMetrics(handler: (metrics: AnalyticsMetrics) => void): void {
    this.emitter.on('analytics.metrics', handler);
  }

  /** Unsubscribe from metric events */
  offMetrics(handler: (metrics: AnalyticsMetrics) => void): void {
    this.emitter.off('analytics.metrics', handler);
  }

  async computeAndBroadcast(tenantId: string): Promise<AnalyticsMetrics> {
    const metrics = await this.computeMetrics(tenantId);
    await this.redis.publish(this.REDIS_CHANNEL, JSON.stringify(metrics));
    return metrics;
  }

  async computeMetrics(tenantId: string): Promise<AnalyticsMetrics> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [depositResult, activeLoans, pendingApps, memberCount, nplLoans, totalLoans] =
      await Promise.all([
        this.prisma.transaction.aggregate({
          where: { tenantId, type: 'DEPOSIT', status: 'COMPLETED', createdAt: { gte: today } },
          _sum: { amount: true },
        }),
        this.prisma.loan.count({
          where: { tenantId, status: { in: ['ACTIVE', 'DISBURSED'] } },
        }),
        this.prisma.loan.count({
          where: {
            tenantId,
            status: { in: ['DRAFT', 'PENDING_GUARANTORS', 'UNDER_REVIEW', 'PENDING_APPROVAL'] },
          },
        }),
        this.prisma.member.count({ where: { tenantId, isActive: true } }),
        this.prisma.loan.aggregate({
          where: { tenantId, staging: 'NPL' },
          _sum: { outstandingBalance: true },
        }),
        this.prisma.loan.aggregate({
          where: { tenantId, status: { in: ['ACTIVE', 'DISBURSED'] } },
          _sum: { outstandingBalance: true },
        }),
      ]);

    const totalLoanPortfolio = Number(totalLoans._sum.outstandingBalance ?? 0);
    const nplAmount = Number(nplLoans._sum.outstandingBalance ?? 0);
    const nplRatio = totalLoanPortfolio > 0 ? nplAmount / totalLoanPortfolio : 0;

    const latestSasra = await this.prisma.sasraRatioSnapshot.findFirst({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      tenantId,
      timestamp: new Date().toISOString(),
      totalDepositsToday: Number(depositResult._sum.amount ?? 0),
      activeLoans,
      pendingApplications: pendingApps,
      nplRatio: Math.round(nplRatio * 10000) / 100,
      liquidityRatio: latestSasra ? Number(latestSasra.liquidityRatio) : 0,
      memberCount,
    };
  }

  onModuleDestroy(): void {
    this.subscriber?.disconnect();
    this.emitter.removeAllListeners();
  }
}
