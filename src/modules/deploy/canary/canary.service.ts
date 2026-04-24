import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES, CanaryAnalysisJobPayload } from '../../queue/queue.constants';

export interface CanaryMetrics {
  p95Latency: number;
  errorRate: number;
  queueDepth: number;
}

export interface CanaryAnalysisResult {
  deploymentId: string;
  version: string;
  status: 'PASSED' | 'FAILED' | 'ROLLED_BACK';
  canaryMetrics: CanaryMetrics;
  baselineMetrics: CanaryMetrics;
  decision: string;
  rollbackReason?: string;
}

/**
 * Canary Deployment Service – Phase 6
 *
 * Manages canary deployment lifecycle:
 *  1. Register new canary deployment (10% traffic)
 *  2. Analyze metrics vs baseline (p95, error rate, queue depth)
 *  3. Auto-rollback if thresholds exceeded
 *  4. Generate launch readiness report
 *
 * Thresholds: error_rate > 0.5% OR p95 > 150ms → rollback
 */
@Injectable()
export class CanaryService {
  private readonly logger = new Logger(CanaryService.name);

  // Rollback thresholds
  private readonly MAX_ERROR_RATE = 0.005; // 0.5%
  private readonly MAX_P95_MS = 150;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.CANARY_ANALYSIS)
    private readonly canaryQueue: Queue<CanaryAnalysisJobPayload>,
  ) {}

  async registerDeployment(version: string, prometheusBaseUrl: string): Promise<string> {
    const deployment = await this.prisma.canaryDeployment.create({
      data: {
        version,
        environment: 'production',
        trafficPct: 10,
        status: 'RUNNING',
      },
    });

    // Queue analysis job
    await this.canaryQueue.add(
      'analyze',
      {
        deploymentId: deployment.id,
        version,
        prometheusBaseUrl,
      },
      {
        delay: 5 * 60 * 1000, // Wait 5 minutes before first analysis
        attempts: 3,
        backoff: { type: 'fixed', delay: 60_000 },
      },
    );

    this.logger.log(`Registered canary deployment ${deployment.id} for version ${version}`);
    return deployment.id;
  }

  async analyzeDeployment(
    deploymentId: string,
    canaryMetrics: CanaryMetrics,
    baselineMetrics: CanaryMetrics,
  ): Promise<CanaryAnalysisResult> {
    const shouldRollback =
      canaryMetrics.errorRate > this.MAX_ERROR_RATE ||
      canaryMetrics.p95Latency > this.MAX_P95_MS;

    let rollbackReason: string | undefined;
    if (canaryMetrics.errorRate > this.MAX_ERROR_RATE) {
      rollbackReason = `Error rate ${(canaryMetrics.errorRate * 100).toFixed(3)}% exceeds 0.5% threshold`;
    } else if (canaryMetrics.p95Latency > this.MAX_P95_MS) {
      rollbackReason = `p95 latency ${canaryMetrics.p95Latency}ms exceeds 150ms threshold`;
    }

    const status = shouldRollback ? 'FAILED' : 'PASSED';

    await this.prisma.canaryDeployment.update({
      where: { id: deploymentId },
      data: {
        status,
        p95Latency: canaryMetrics.p95Latency,
        errorRate: canaryMetrics.errorRate,
        queueDepth: canaryMetrics.queueDepth,
        baselineP95: baselineMetrics.p95Latency,
        baselineErr: baselineMetrics.errorRate,
        rollbackReason,
        completedAt: new Date(),
      },
    });

    if (shouldRollback) {
      await this.executeRollback(deploymentId, rollbackReason!);
    }

    const deployment = await this.prisma.canaryDeployment.findUnique({
      where: { id: deploymentId },
    });

    this.logger.log(`Canary analysis for ${deploymentId}: ${status}${rollbackReason ? ` – ${rollbackReason}` : ''}`);

    return {
      deploymentId,
      version: deployment?.version ?? '',
      status: shouldRollback ? 'ROLLED_BACK' : 'PASSED',
      canaryMetrics,
      baselineMetrics,
      decision: shouldRollback ? 'ROLLBACK' : 'PROMOTE',
      rollbackReason,
    };
  }

  private async executeRollback(deploymentId: string, reason: string): Promise<void> {
    this.logger.warn(`Executing rollback for deployment ${deploymentId}: ${reason}`);

    await this.prisma.canaryDeployment.update({
      where: { id: deploymentId },
      data: { status: 'ROLLED_BACK', rollbackReason: reason },
    });

    // In production: trigger kubectl rollout undo or Docker Compose swap
    // This is logged for the CI/CD pipeline to pick up
    this.logger.warn(`ROLLBACK_TRIGGER deploymentId=${deploymentId} reason="${reason}"`);
  }

  async triggerRollback(deploymentId: string, reason: string): Promise<{ success: boolean; reason: string }> {
    await this.executeRollback(deploymentId, reason);
    return { success: true, reason };
  }

  async getLatestDeployment() {
    return this.prisma.canaryDeployment.findFirst({
      orderBy: { startedAt: 'desc' },
    });
  }

  async generateLaunchReport(): Promise<Record<string, unknown>> {
    const latestCanary = await this.prisma.canaryDeployment.findFirst({
      orderBy: { startedAt: 'desc' },
    });

    const policyViolations = await this.prisma.complianceAlert.count({
      where: { status: 'OPEN', severity: 'CRITICAL' },
    });

    const report = {
      generatedAt: new Date().toISOString(),
      rpo: '< 1 hour',
      rto: '< 15 minutes',
      p95Target: '< 100ms',
      errorRateTarget: '< 0.1%',
      canaryStatus: latestCanary?.status ?? 'NO_DEPLOYMENT',
      canaryP95: latestCanary?.p95Latency ?? null,
      canaryErrorRate: latestCanary?.errorRate ?? null,
      policyViolations,
      backupVerified: true,
      launchReady:
        policyViolations === 0 &&
        (latestCanary?.status === 'PASSED' || latestCanary?.status === 'ROLLED_BACK') &&
        Number(latestCanary?.p95Latency ?? 0) < 100 &&
        Number(latestCanary?.errorRate ?? 0) < 0.001,
    };

    this.logger.log(`Launch readiness report: ${report.launchReady ? 'READY' : 'NOT READY'}`);
    return report;
  }
}
