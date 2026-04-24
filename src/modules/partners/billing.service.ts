/**
 * Phase 7 – Usage Metering & Billing Service
 * Tracks calls, dataVolume, errors, latencyP95 per partner key.
 * @Billable() decorator increments counters atomically in Redis.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';

export interface UsageMetrics {
  partnerId: string;
  period: string;
  calls: number;
  errors: number;
  dataVolumeBytes: number;
  latencyP95Ms: number;
  cost: number;
}

export interface BillingPeriod {
  start: Date;
  end: Date;
  label: string;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  // Rate card: cost per 1000 API calls by tier
  private readonly rateCard: Record<string, number> = {
    basic: 0.5,
    standard: 1.0,
    premium: 2.0,
    enterprise: 5.0,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Atomically increment usage counters for a partner API call.
   * Called by @Billable() decorator.
   */
  async recordApiCall(
    partnerId: string,
    opts: {
      success: boolean;
      latencyMs: number;
      responseBytes?: number;
    },
  ): Promise<void> {
    const period = this.getCurrentPeriodKey();
    const prefix = `billing:${partnerId}:${period}`;

    await Promise.all([
      this.redis.incr(`${prefix}:calls`),
      opts.success ? Promise.resolve() : this.redis.incr(`${prefix}:errors`),
      this.redis.incrBy(`${prefix}:bytes`, opts.responseBytes ?? 0),
      this.updateLatencyP95(partnerId, period, opts.latencyMs),
    ]);

    // Set TTL on first write (keep 90 days)
    await this.redis.expire(`${prefix}:calls`, 86400 * 90);
  }

  /**
   * Get usage metrics for a partner for a given period.
   */
  async getUsage(
    partnerId: string,
    periodType: 'DAY' | 'WEEK' | 'MONTH',
  ): Promise<UsageMetrics[]> {
    const periods = this.getPeriodKeys(periodType);
    const results: UsageMetrics[] = [];

    for (const period of periods) {
      const prefix = `billing:${partnerId}:${period}`;
      const [calls, errors, bytes, p95] = await Promise.all([
        this.redis.get(`${prefix}:calls`),
        this.redis.get(`${prefix}:errors`),
        this.redis.get(`${prefix}:bytes`),
        this.redis.get(`${prefix}:p95`),
      ]);

      const callCount = parseInt(calls ?? '0', 10);
      const partner = await this.prisma.partner.findUnique({
        where: { id: partnerId },
        select: { rateLimitTier: true },
      });
      const tier = partner?.rateLimitTier ?? 'standard';
      const rate = this.rateCard[tier] ?? 1.0;

      results.push({
        partnerId,
        period,
        calls: callCount,
        errors: parseInt(errors ?? '0', 10),
        dataVolumeBytes: parseInt(bytes ?? '0', 10),
        latencyP95Ms: parseFloat(p95 ?? '0'),
        cost: (callCount / 1000) * rate,
      });
    }

    return results;
  }

  /**
   * Get aggregated monthly usage for billing invoice.
   */
  async getMonthlyInvoice(
    partnerId: string,
    yearMonth: string, // YYYY-MM
  ): Promise<{
    partnerId: string;
    period: string;
    totalCalls: number;
    totalErrors: number;
    totalBytes: number;
    avgP95Ms: number;
    totalCostKes: number;
  }> {
    const prefix = `billing:${partnerId}:${yearMonth}`;
    const [calls, errors, bytes, p95] = await Promise.all([
      this.redis.get(`${prefix}:calls`),
      this.redis.get(`${prefix}:errors`),
      this.redis.get(`${prefix}:bytes`),
      this.redis.get(`${prefix}:p95`),
    ]);

    const callCount = parseInt(calls ?? '0', 10);
    const partner = await this.prisma.partner.findUnique({
      where: { id: partnerId },
      select: { rateLimitTier: true },
    });
    const tier = partner?.rateLimitTier ?? 'standard';
    const rate = this.rateCard[tier] ?? 1.0;

    return {
      partnerId,
      period: yearMonth,
      totalCalls: callCount,
      totalErrors: parseInt(errors ?? '0', 10),
      totalBytes: parseInt(bytes ?? '0', 10),
      avgP95Ms: parseFloat(p95 ?? '0'),
      totalCostKes: (callCount / 1000) * rate,
    };
  }

  /**
   * Store a billing snapshot to the database for audit.
   */
  async persistBillingSnapshot(partnerId: string, yearMonth: string): Promise<void> {
    const invoice = await this.getMonthlyInvoice(partnerId, yearMonth);

    await this.prisma.partnerUsageSnapshot.upsert({
      where: { partnerId_period: { partnerId, period: yearMonth } },
      create: {
        partnerId,
        period: yearMonth,
        totalCalls: invoice.totalCalls,
        totalErrors: invoice.totalErrors,
        totalBytes: invoice.totalBytes,
        avgP95Ms: invoice.avgP95Ms,
        totalCostKes: invoice.totalCostKes,
      },
      update: {
        totalCalls: invoice.totalCalls,
        totalErrors: invoice.totalErrors,
        totalBytes: invoice.totalBytes,
        avgP95Ms: invoice.avgP95Ms,
        totalCostKes: invoice.totalCostKes,
      },
    });

    this.logger.log(`[Billing] Persisted snapshot for partner ${partnerId} period ${yearMonth}`);
  }

  private async updateLatencyP95(
    partnerId: string,
    period: string,
    latencyMs: number,
  ): Promise<void> {
    const key = `billing:${partnerId}:${period}:latencies`;
    // Store last 1000 latency samples for P95 calculation
    const raw = await this.redis.get(key);
    const samples: number[] = raw ? JSON.parse(raw) : [];
    samples.push(latencyMs);
    if (samples.length > 1000) samples.shift();

    const sorted = [...samples].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p95 = sorted[p95Index] ?? 0;

    await this.redis.set(`billing:${partnerId}:${period}:p95`, p95.toString(), 86400 * 90);
    await this.redis.set(key, JSON.stringify(samples), 86400 * 90);
  }

  private getCurrentPeriodKey(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  private getPeriodKeys(type: 'DAY' | 'WEEK' | 'MONTH'): string[] {
    const now = new Date();
    const keys: string[] = [];

    if (type === 'MONTH') {
      // Last 3 months
      for (let i = 0; i < 3; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
      }
    } else if (type === 'WEEK') {
      // Last 4 weeks (by month key)
      keys.push(this.getCurrentPeriodKey());
    } else {
      // Current month
      keys.push(this.getCurrentPeriodKey());
    }

    return keys;
  }
}
