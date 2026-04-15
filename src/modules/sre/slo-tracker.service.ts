/**
 * Phase 7 – SLO/SLI Tracking & Error Budget
 * Defines: Availability 99.95%, Latency p95 < 100ms, ErrorRate < 0.1%.
 * Tracks consumption vs budget. Real-time burn rate monitoring.
 */
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/services/redis.service';

export interface SloDefinition {
  name: string;
  target: number;       // e.g., 0.9995 for 99.95%
  windowDays: number;   // rolling window
  unit: 'AVAILABILITY' | 'LATENCY_P95' | 'ERROR_RATE';
  threshold: number;    // latency in ms, or rate as decimal
}

export interface SloBurnRate {
  slo: string;
  target: number;
  current: number;
  errorBudgetTotal: number;    // total allowed errors/downtime in window
  errorBudgetConsumed: number; // consumed so far
  errorBudgetRemaining: number;
  burnRate: number;            // current consumption rate (1.0 = on track)
  projectedExhaustion?: string; // ISO date when budget will be exhausted
  status: 'OK' | 'WARNING' | 'CRITICAL' | 'EXHAUSTED';
  alerts: string[];
}

export interface SloReport {
  tenantId: string;
  generatedAt: string;
  windowDays: number;
  slos: SloBurnRate[];
  overallStatus: 'OK' | 'WARNING' | 'CRITICAL';
}

const SLO_DEFINITIONS: SloDefinition[] = [
  {
    name: 'availability',
    target: 0.9995,
    windowDays: 30,
    unit: 'AVAILABILITY',
    threshold: 0.9995,
  },
  {
    name: 'latency_p95',
    target: 0.95,
    windowDays: 30,
    unit: 'LATENCY_P95',
    threshold: 100, // ms
  },
  {
    name: 'error_rate',
    target: 0.999,
    windowDays: 30,
    unit: 'ERROR_RATE',
    threshold: 0.001, // 0.1%
  },
];

@Injectable()
export class SloTrackerService {
  private readonly logger = new Logger(SloTrackerService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Get real-time SLO burn rates and error budget status.
   */
  async getSloReport(tenantId: string): Promise<SloReport> {
    const slos = await Promise.all(
      SLO_DEFINITIONS.map((def) => this.calculateBurnRate(tenantId, def)),
    );

    const hasWarning = slos.some((s) => s.status === 'WARNING');
    const hasCritical = slos.some((s) => s.status === 'CRITICAL' || s.status === 'EXHAUSTED');

    return {
      tenantId,
      generatedAt: new Date().toISOString(),
      windowDays: 30,
      slos,
      overallStatus: hasCritical ? 'CRITICAL' : hasWarning ? 'WARNING' : 'OK',
    };
  }

  /**
   * Record a request outcome for SLO tracking.
   */
  async recordRequest(
    tenantId: string,
    opts: {
      success: boolean;
      latencyMs: number;
      timestamp?: Date;
    },
  ): Promise<void> {
    const ts = opts.timestamp ?? new Date();
    const hourKey = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')}-${String(ts.getHours()).padStart(2, '0')}`;
    const prefix = `slo:${tenantId}:${hourKey}`;

    await Promise.all([
      this.redis.incr(`${prefix}:total`, 86400 * 31),
      opts.success ? Promise.resolve() : this.redis.incr(`${prefix}:errors`, 86400 * 31),
      this.updateLatencyBucket(tenantId, hourKey, opts.latencyMs),
    ]);
  }

  /**
   * Record downtime event.
   */
  async recordDowntime(tenantId: string, durationMs: number): Promise<void> {
    const key = `slo:${tenantId}:downtime:${Date.now()}`;
    await this.redis.set(key, durationMs.toString(), 86400 * 31);
    this.logger.warn(`[SLO] Downtime recorded for tenant ${tenantId}: ${durationMs}ms`);
  }

  /**
   * Check if error budget is below threshold (used by canary rollback).
   */
  async isErrorBudgetExhausted(tenantId: string, thresholdPct = 0.5): Promise<boolean> {
    const report = await this.getSloReport(tenantId);
    const errorRateSlo = report.slos.find((s) => s.slo === 'error_rate');
    if (!errorRateSlo) return false;

    const consumed = errorRateSlo.errorBudgetConsumed / errorRateSlo.errorBudgetTotal;
    return consumed > thresholdPct;
  }

  private async calculateBurnRate(tenantId: string, def: SloDefinition): Promise<SloBurnRate> {
    const { total, errors, downtimeMs, p95Latency } = await this.getWindowMetrics(tenantId, def.windowDays);

    let current: number;
    let errorBudgetTotal: number;
    let errorBudgetConsumed: number;

    if (def.unit === 'AVAILABILITY') {
      const uptimeMs = def.windowDays * 86400000 - downtimeMs;
      current = uptimeMs / (def.windowDays * 86400000);
      errorBudgetTotal = (1 - def.target) * def.windowDays * 86400000; // allowed downtime ms
      errorBudgetConsumed = downtimeMs;
    } else if (def.unit === 'ERROR_RATE') {
      current = total > 0 ? 1 - errors / total : 1;
      errorBudgetTotal = (1 - def.target) * total; // allowed error count
      errorBudgetConsumed = errors;
    } else {
      // LATENCY_P95
      current = p95Latency <= def.threshold ? 1 : 0;
      errorBudgetTotal = total * (1 - def.target); // allowed slow requests
      const slowRequests = await this.getSlowRequestCount(tenantId, def.windowDays, def.threshold);
      errorBudgetConsumed = slowRequests;
    }

    const errorBudgetRemaining = Math.max(0, errorBudgetTotal - errorBudgetConsumed);
    const burnRate = errorBudgetTotal > 0 ? errorBudgetConsumed / errorBudgetTotal : 0;

    const alerts: string[] = [];
    let status: SloBurnRate['status'] = 'OK';

    if (burnRate >= 1.0) {
      status = 'EXHAUSTED';
      alerts.push(`Error budget exhausted for ${def.name}`);
    } else if (burnRate >= 0.8) {
      status = 'CRITICAL';
      alerts.push(`Error budget 80%+ consumed for ${def.name} – immediate action required`);
    } else if (burnRate >= 0.5) {
      status = 'WARNING';
      alerts.push(`Error budget 50%+ consumed for ${def.name}`);
    }

    // Project exhaustion date
    let projectedExhaustion: string | undefined;
    if (burnRate > 0 && burnRate < 1) {
      const daysRemaining = (errorBudgetRemaining / errorBudgetConsumed) * def.windowDays;
      const exhaustionDate = new Date(Date.now() + daysRemaining * 86400000);
      projectedExhaustion = exhaustionDate.toISOString();
    }

    return {
      slo: def.name,
      target: def.target,
      current,
      errorBudgetTotal,
      errorBudgetConsumed,
      errorBudgetRemaining,
      burnRate,
      projectedExhaustion,
      status,
      alerts,
    };
  }

  private async getWindowMetrics(
    tenantId: string,
    windowDays: number,
  ): Promise<{ total: number; errors: number; downtimeMs: number; p95Latency: number }> {
    const now = new Date();
    let total = 0;
    let errors = 0;

    // Aggregate hourly buckets for the window
    for (let d = 0; d < windowDays; d++) {
      const day = new Date(now.getTime() - d * 86400000);
      for (let h = 0; h < 24; h++) {
        const hourKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}-${String(h).padStart(2, '0')}`;
        const prefix = `slo:${tenantId}:${hourKey}`;
        const [t, e] = await Promise.all([
          this.redis.get(`${prefix}:total`),
          this.redis.get(`${prefix}:errors`),
        ]);
        total += parseInt(t ?? '0', 10);
        errors += parseInt(e ?? '0', 10);
      }
    }

    // Downtime
    const downtimeKeys = await this.redis.scanKeys(`slo:${tenantId}:downtime:*`);
    let downtimeMs = 0;
    for (const key of downtimeKeys) {
      const val = await this.redis.get(key);
      downtimeMs += parseInt(val ?? '0', 10);
    }

    // P95 latency (from latest hour)
    const latestHourKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}`;
    const p95Raw = await this.redis.get(`slo:${tenantId}:${latestHourKey}:p95`);
    const p95Latency = parseFloat(p95Raw ?? '0');

    return { total, errors, downtimeMs, p95Latency };
  }

  private async updateLatencyBucket(tenantId: string, hourKey: string, latencyMs: number): Promise<void> {
    const key = `slo:${tenantId}:${hourKey}:latencies`;
    const raw = await this.redis.get(key);
    const samples: number[] = raw ? JSON.parse(raw) : [];
    samples.push(latencyMs);
    if (samples.length > 500) samples.shift();

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;

    await this.redis.set(`slo:${tenantId}:${hourKey}:p95`, p95.toString(), 86400 * 31);
    await this.redis.set(key, JSON.stringify(samples), 86400 * 31);
  }

  private async getSlowRequestCount(
    tenantId: string,
    windowDays: number,
    thresholdMs: number,
  ): Promise<number> {
    // Stub: In production, query from metrics store
    void tenantId;
    void windowDays;
    void thresholdMs;
    return 0;
  }
}
