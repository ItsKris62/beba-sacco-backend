/**
 * Phase 7 – FinOps Cost Optimization Service
 * Tags cloud resources, tracks idle pods, over-provisioned DBs, queue backlogs.
 * Returns cost per tenant, queue efficiency, scaling recommendations.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';

export interface FinOpsReport {
  tenantId: string;
  generatedAt: string;
  costPerTenant: {
    computeKes: number;
    storageKes: number;
    networkKes: number;
    totalKes: number;
  };
  queueEfficiency: {
    queueName: string;
    depth: number;
    processingRate: number;
    avgLatencyMs: number;
    efficiency: 'OPTIMAL' | 'DEGRADED' | 'BACKLOGGED';
  }[];
  idleResources: {
    resource: string;
    type: 'POD' | 'DB_CONNECTION' | 'CACHE_KEY' | 'QUEUE';
    wastedKes: number;
    recommendation: string;
  }[];
  scalingRecommendations: string[];
  totalWastedKes: number;
  savingsOpportunityKes: number;
}

@Injectable()
export class FinOpsService {
  private readonly logger = new Logger(FinOpsService.name);

  // Approximate cost rates (KES per unit per month)
  private readonly costRates = {
    podPerHour: 2.5,          // KES per pod-hour
    dbConnectionPerHour: 0.5, // KES per DB connection-hour
    storagePerGbMonth: 8.0,   // KES per GB/month
    networkPerGb: 1.2,        // KES per GB transferred
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Generate a FinOps report for a tenant.
   */
  async generateReport(tenantId: string): Promise<FinOpsReport> {
    this.logger.log(`[FinOps] Generating report for tenant ${tenantId}`);

    const [costPerTenant, queueEfficiency, idleResources] = await Promise.all([
      this.calculateCostPerTenant(tenantId),
      this.analyzeQueueEfficiency(),
      this.detectIdleResources(tenantId),
    ]);

    const totalWasted = idleResources.reduce((sum, r) => sum + r.wastedKes, 0);
    const savingsOpportunity = totalWasted * 0.7; // 70% of waste is recoverable

    const recommendations = this.buildRecommendations(queueEfficiency, idleResources, costPerTenant);

    return {
      tenantId,
      generatedAt: new Date().toISOString(),
      costPerTenant,
      queueEfficiency,
      idleResources,
      scalingRecommendations: recommendations,
      totalWastedKes: totalWasted,
      savingsOpportunityKes: savingsOpportunity,
    };
  }

  /**
   * Record resource usage for cost tracking.
   */
  async recordResourceUsage(
    tenantId: string,
    resource: string,
    units: number,
  ): Promise<void> {
    const key = `finops:${tenantId}:${resource}:${this.getCurrentMonthKey()}`;
    await this.redis.incrBy(key, units, 86400 * 35);
  }

  private async calculateCostPerTenant(tenantId: string): Promise<FinOpsReport['costPerTenant']> {
    const monthKey = this.getCurrentMonthKey();

    // Get usage from Redis counters
    const [apiCalls, storageGb, networkGb] = await Promise.all([
      this.redis.get(`finops:${tenantId}:api_calls:${monthKey}`),
      this.redis.get(`finops:${tenantId}:storage_gb:${monthKey}`),
      this.redis.get(`finops:${tenantId}:network_gb:${monthKey}`),
    ]);

    // Estimate compute from API calls (1 pod-hour per 10k calls)
    const calls = parseInt(apiCalls ?? '0', 10);
    const computeKes = (calls / 10000) * this.costRates.podPerHour;
    const storageKes = parseFloat(storageGb ?? '0') * this.costRates.storagePerGbMonth;
    const networkKes = parseFloat(networkGb ?? '0') * this.costRates.networkPerGb;

    return {
      computeKes: Math.round(computeKes * 100) / 100,
      storageKes: Math.round(storageKes * 100) / 100,
      networkKes: Math.round(networkKes * 100) / 100,
      totalKes: Math.round((computeKes + storageKes + networkKes) * 100) / 100,
    };
  }

  private async analyzeQueueEfficiency(): Promise<FinOpsReport['queueEfficiency']> {
    const queues = [
      'integrations.crb-export',
      'integrations.aml-screen',
      'notifications.multi-channel',
      'analytics.stream',
      'risk.score',
      'governance.data-erasure',
      'partners.provision',
    ];

    const results: FinOpsReport['queueEfficiency'] = [];

    for (const queueName of queues) {
      const depthKey = `queue:depth:${queueName}`;
      const rateKey = `queue:rate:${queueName}`;
      const latencyKey = `queue:latency:${queueName}`;

      const [depth, rate, latency] = await Promise.all([
        this.redis.get(depthKey),
        this.redis.get(rateKey),
        this.redis.get(latencyKey),
      ]);

      const depthVal = parseInt(depth ?? '0', 10);
      const rateVal = parseFloat(rate ?? '10');
      const latencyVal = parseFloat(latency ?? '50');

      let efficiency: 'OPTIMAL' | 'DEGRADED' | 'BACKLOGGED' = 'OPTIMAL';
      if (depthVal > 1000) efficiency = 'BACKLOGGED';
      else if (depthVal > 100 || latencyVal > 5000) efficiency = 'DEGRADED';

      results.push({
        queueName,
        depth: depthVal,
        processingRate: rateVal,
        avgLatencyMs: latencyVal,
        efficiency,
      });
    }

    return results;
  }

  private async detectIdleResources(tenantId: string): Promise<FinOpsReport['idleResources']> {
    const idle: FinOpsReport['idleResources'] = [];

    // Check for idle DB connections (stub)
    const dbConnKey = `finops:${tenantId}:db_connections:active`;
    const activeConns = parseInt((await this.redis.get(dbConnKey)) ?? '5', 10);
    if (activeConns > 20) {
      idle.push({
        resource: 'PostgreSQL connection pool',
        type: 'DB_CONNECTION',
        wastedKes: (activeConns - 10) * this.costRates.dbConnectionPerHour * 720,
        recommendation: `Reduce connection pool from ${activeConns} to 10 (save ${((activeConns - 10) * this.costRates.dbConnectionPerHour * 720).toFixed(0)} KES/month)`,
      });
    }

    // Check for stale Redis keys
    const staleKeys = await this.redis.scanKeys(`threat:record:${tenantId}:*`);
    if (staleKeys.length > 10000) {
      idle.push({
        resource: 'Redis threat records',
        type: 'CACHE_KEY',
        wastedKes: staleKeys.length * 0.001,
        recommendation: `${staleKeys.length} stale threat records consuming Redis memory. Run cleanup job.`,
      });
    }

    // Check for backlogged queues
    const backloggedQueues = await this.analyzeQueueEfficiency();
    for (const q of backloggedQueues.filter((q) => q.efficiency === 'BACKLOGGED')) {
      idle.push({
        resource: q.queueName,
        type: 'QUEUE',
        wastedKes: q.depth * 0.01,
        recommendation: `Queue ${q.queueName} has ${q.depth} backlogged jobs. Scale workers by 2x.`,
      });
    }

    return idle;
  }

  private buildRecommendations(
    queues: FinOpsReport['queueEfficiency'],
    idle: FinOpsReport['idleResources'],
    cost: FinOpsReport['costPerTenant'],
  ): string[] {
    const recs: string[] = [];

    const backlogged = queues.filter((q) => q.efficiency === 'BACKLOGGED');
    if (backlogged.length > 0) {
      recs.push(`Scale up workers for ${backlogged.length} backlogged queue(s): ${backlogged.map((q) => q.queueName).join(', ')}`);
    }

    if (idle.length > 0) {
      recs.push(`${idle.length} idle resource(s) detected. Estimated savings: ${idle.reduce((s, r) => s + r.wastedKes, 0).toFixed(0)} KES/month`);
    }

    if (cost.computeKes > 5000) {
      recs.push('Consider horizontal pod autoscaling to reduce compute costs during off-peak hours');
    }

    if (cost.storageKes > 2000) {
      recs.push('Enable MinIO lifecycle policies to archive audit logs older than 90 days');
    }

    recs.push('Enable PgBouncer connection pooling to reduce DB connection overhead');
    recs.push('Review Redis key TTLs – ensure all keys have appropriate expiry');

    return recs;
  }

  private getCurrentMonthKey(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
}
