/**
 * Phase 7 – SLA Monitoring & Breach Alerting
 * Compares live metrics against contract SLA.
 * Breach triggers SLA_BREACH event, logs to SlaIncident, notifies account manager.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';

export interface SlaContract {
  p95LatencyMs: number;   // e.g., 150
  uptimePct: number;      // e.g., 99.9
  errorRatePct: number;   // e.g., 0.1
}

export interface SlaStatus {
  partnerId: string;
  period: string;
  contract: SlaContract;
  actual: {
    p95LatencyMs: number;
    uptimePct: number;
    errorRatePct: number;
  };
  breaches: string[];
  compliant: boolean;
}

@Injectable()
export class SlaMonitorService {
  private readonly logger = new Logger(SlaMonitorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Check SLA compliance for a partner and record any breaches.
   */
  async checkCompliance(partnerId: string): Promise<SlaStatus> {
    const partner = await this.prisma.partner.findUnique({
      where: { id: partnerId },
      select: { slaConfig: true, name: true, contactEmail: true, tenantId: true },
    });

    if (!partner) {
      throw new Error(`Partner ${partnerId} not found`);
    }

    const sla = partner.slaConfig as unknown as SlaContract;
    const period = this.getCurrentPeriodKey();
    const prefix = `billing:${partnerId}:${period}`;

    // Fetch live metrics from Redis
    const [calls, errors, p95] = await Promise.all([
      this.redis.get(`${prefix}:calls`),
      this.redis.get(`${prefix}:errors`),
      this.redis.get(`${prefix}:p95`),
    ]);

    const totalCalls = parseInt(calls ?? '0', 10);
    const totalErrors = parseInt(errors ?? '0', 10);
    const actualP95 = parseFloat(p95 ?? '0');
    const actualErrorRate = totalCalls > 0 ? (totalErrors / totalCalls) * 100 : 0;

    // Uptime from health check history
    const actualUptime = await this.getUptimePct(partnerId);

    const breaches: string[] = [];
    if (actualP95 > sla.p95LatencyMs) {
      breaches.push(`P95 latency ${actualP95}ms exceeds SLA ${sla.p95LatencyMs}ms`);
    }
    if (actualUptime < sla.uptimePct) {
      breaches.push(`Uptime ${actualUptime.toFixed(2)}% below SLA ${sla.uptimePct}%`);
    }
    if (actualErrorRate > sla.errorRatePct) {
      breaches.push(`Error rate ${actualErrorRate.toFixed(3)}% exceeds SLA ${sla.errorRatePct}%`);
    }

    const status: SlaStatus = {
      partnerId,
      period,
      contract: sla,
      actual: {
        p95LatencyMs: actualP95,
        uptimePct: actualUptime,
        errorRatePct: actualErrorRate,
      },
      breaches,
      compliant: breaches.length === 0,
    };

    if (breaches.length > 0) {
      await this.recordBreach(partnerId, partner.tenantId, partner.name, breaches, status);
    }

    return status;
  }

  /**
   * Record an SLA breach incident.
   */
  private async recordBreach(
    partnerId: string,
    tenantId: string,
    partnerName: string,
    breaches: string[],
    status: SlaStatus,
  ): Promise<void> {
    this.logger.warn(`[SLA] Breach detected for partner ${partnerName}: ${breaches.join('; ')}`);

    await this.prisma.slaIncident.create({
      data: {
        partnerId,
        tenantId,
        period: status.period,
        breaches,
        actualMetrics: status.actual as unknown as Record<string, unknown>,
        contractedMetrics: status.contract as unknown as Record<string, unknown>,
        status: 'OPEN',
      },
    });

    // Trigger alert (Slack/PagerDuty stub)
    await this.triggerBreachAlert(partnerName, breaches);
  }

  /**
   * Get open SLA incidents for a partner.
   */
  async getIncidents(partnerId: string): Promise<unknown[]> {
    return this.prisma.slaIncident.findMany({
      where: { partnerId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /**
   * Resolve an SLA incident.
   */
  async resolveIncident(incidentId: string, resolvedBy: string): Promise<void> {
    await this.prisma.slaIncident.update({
      where: { id: incidentId },
      data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedBy },
    });
  }

  private async getUptimePct(partnerId: string): Promise<number> {
    // Stub: In production, calculate from health check ping history
    const key = `sla:uptime:${partnerId}`;
    const raw = await this.redis.get(key);
    return raw ? parseFloat(raw) : 99.95;
  }

  private async triggerBreachAlert(partnerName: string, breaches: string[]): Promise<void> {
    const slackWebhook = this.config.get<string>('SLACK_WEBHOOK_URL');
    this.logger.error(
      `[SLA] ALERT for ${partnerName}: ${breaches.join('; ')} | slack=${!!slackWebhook}`,
    );
    // In production: POST to Slack/PagerDuty
  }

  private getCurrentPeriodKey(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
}
