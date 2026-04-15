/**
 * Phase 7 – Advanced Threat Detection Service
 * Redis-backed threat matrix: ipReputation, deviceFingerprint,
 * loginAnomalyScore, transactionVelocity.
 * Scores >80 trigger block + Slack/PagerDuty alert.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../common/services/redis.service';

export interface ThreatMatrix {
  ipReputation: number;       // 0-100 (100 = known malicious)
  deviceFingerprint: number;  // 0-100 (100 = unknown/spoofed device)
  loginAnomalyScore: number;  // 0-100 (100 = highly anomalous)
  transactionVelocity: number; // 0-100 (100 = extreme velocity)
  compositeScore: number;     // weighted average
}

export interface ThreatContext {
  tenantId: string;
  userId?: string;
  ipAddress: string;
  userAgent?: string;
  deviceId?: string;
  action: string;
  amount?: number;
}

const THREAT_BLOCK_THRESHOLD = 80;
const TTL_SECONDS = 3600; // 1 hour window

@Injectable()
export class ThreatDetectionService {
  private readonly logger = new Logger(ThreatDetectionService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Evaluate threat score for a request context.
   * Returns composite score and individual dimensions.
   */
  async evaluate(ctx: ThreatContext): Promise<ThreatMatrix> {
    const [ipRep, deviceFp, loginAnomaly, txVelocity] = await Promise.all([
      this.scoreIpReputation(ctx.ipAddress),
      this.scoreDeviceFingerprint(ctx.deviceId, ctx.tenantId, ctx.userId),
      this.scoreLoginAnomaly(ctx.tenantId, ctx.userId, ctx.ipAddress),
      this.scoreTransactionVelocity(ctx.tenantId, ctx.userId, ctx.amount),
    ]);

    // Weighted composite: IP 30%, device 25%, login 25%, velocity 20%
    const composite = Math.round(
      ipRep * 0.3 + deviceFp * 0.25 + loginAnomaly * 0.25 + txVelocity * 0.2,
    );

    const matrix: ThreatMatrix = {
      ipReputation: ipRep,
      deviceFingerprint: deviceFp,
      loginAnomalyScore: loginAnomaly,
      transactionVelocity: txVelocity,
      compositeScore: composite,
    };

    // Store in Redis for audit trail
    await this.storeThreatRecord(ctx, matrix);

    if (composite >= THREAT_BLOCK_THRESHOLD) {
      this.logger.warn(
        `[ThreatDetection] HIGH THREAT SCORE ${composite} for ${ctx.action} ` +
          `tenant=${ctx.tenantId} ip=${ctx.ipAddress}`,
      );
      await this.triggerAlert(ctx, matrix);
    }

    return matrix;
  }

  /**
   * Check if a request should be blocked based on threat score.
   */
  async shouldBlock(ctx: ThreatContext): Promise<{ blocked: boolean; score: number; reason?: string }> {
    const matrix = await this.evaluate(ctx);
    if (matrix.compositeScore >= THREAT_BLOCK_THRESHOLD) {
      return {
        blocked: true,
        score: matrix.compositeScore,
        reason: this.buildBlockReason(matrix),
      };
    }
    return { blocked: false, score: matrix.compositeScore };
  }

  private async scoreIpReputation(ipAddress: string): Promise<number> {
    const key = `threat:ip:${ipAddress}`;
    const cached = await this.redis.get(key);
    if (cached) return parseInt(cached, 10);

    // Stub: In production, query IP reputation API (e.g., AbuseIPDB, MaxMind)
    const knownBadIps = ['10.0.0.666', '192.168.1.999']; // placeholder
    const score = knownBadIps.includes(ipAddress) ? 95 : 5;
    await this.redis.set(key, score.toString(), TTL_SECONDS);
    return score;
  }

  private async scoreDeviceFingerprint(
    deviceId: string | undefined,
    tenantId: string,
    userId: string | undefined,
  ): Promise<number> {
    if (!deviceId || !userId) return 30; // Unknown device = moderate risk

    const key = `threat:device:${tenantId}:${userId}`;
    const knownDevices = await this.redis.get(key);
    const devices: string[] = knownDevices ? JSON.parse(knownDevices) : [];

    if (devices.includes(deviceId)) return 5; // Known device

    // New device for this user
    devices.push(deviceId);
    if (devices.length > 10) devices.shift(); // Keep last 10
    await this.redis.set(key, JSON.stringify(devices), 86400 * 30); // 30 days
    return 60; // New device = elevated risk
  }

  private async scoreLoginAnomaly(
    tenantId: string,
    userId: string | undefined,
    ipAddress: string,
  ): Promise<number> {
    if (!userId) return 20;

    const failKey = `threat:login:fail:${tenantId}:${userId}`;
    const failCount = await this.redis.get(failKey);
    const failures = failCount ? parseInt(failCount, 10) : 0;

    // Score based on recent failures: 0=0, 3=30, 5=60, 10+=90
    if (failures >= 10) return 90;
    if (failures >= 5) return 60;
    if (failures >= 3) return 30;
    return 5;
  }

  async recordLoginFailure(tenantId: string, userId: string): Promise<void> {
    const key = `threat:login:fail:${tenantId}:${userId}`;
    const current = await this.redis.get(key);
    const count = current ? parseInt(current, 10) + 1 : 1;
    await this.redis.set(key, count.toString(), 3600); // 1 hour window
  }

  async clearLoginFailures(tenantId: string, userId: string): Promise<void> {
    const key = `threat:login:fail:${tenantId}:${userId}`;
    await this.redis.del(key);
  }

  private async scoreTransactionVelocity(
    tenantId: string,
    userId: string | undefined,
    amount?: number,
  ): Promise<number> {
    if (!userId || !amount) return 0;

    const key = `threat:tx:velocity:${tenantId}:${userId}`;
    const windowData = await this.redis.get(key);
    const window: { count: number; total: number } = windowData
      ? JSON.parse(windowData)
      : { count: 0, total: 0 };

    window.count++;
    window.total += amount;
    await this.redis.set(key, JSON.stringify(window), 3600); // 1 hour

    // Score: >20 txns/hr = 70, >50 = 90; >500k KES/hr = 80
    if (window.count > 50 || window.total > 500000) return 90;
    if (window.count > 20 || window.total > 200000) return 70;
    if (window.count > 10 || window.total > 100000) return 40;
    return 5;
  }

  private async storeThreatRecord(ctx: ThreatContext, matrix: ThreatMatrix): Promise<void> {
    const key = `threat:record:${ctx.tenantId}:${Date.now()}`;
    await this.redis.set(
      key,
      JSON.stringify({ ctx, matrix, timestamp: new Date().toISOString() }),
      86400, // 24 hours
    );
  }

  private async triggerAlert(ctx: ThreatContext, matrix: ThreatMatrix): Promise<void> {
    // Stub: In production, call Slack webhook + PagerDuty Events API
    const slackWebhook = this.config.get<string>('SLACK_WEBHOOK_URL');
    const pagerdutyKey = this.config.get<string>('PAGERDUTY_ROUTING_KEY');

    this.logger.error(
      `[ThreatDetection] ALERT: score=${matrix.compositeScore} ` +
        `action=${ctx.action} tenant=${ctx.tenantId} ip=${ctx.ipAddress} ` +
        `slack=${!!slackWebhook} pagerduty=${!!pagerdutyKey}`,
    );

    // In production: POST to Slack/PagerDuty
    // await fetch(slackWebhook, { method: 'POST', body: JSON.stringify({...}) });
  }

  private buildBlockReason(matrix: ThreatMatrix): string {
    const reasons: string[] = [];
    if (matrix.ipReputation >= 80) reasons.push('malicious IP');
    if (matrix.deviceFingerprint >= 80) reasons.push('unknown device');
    if (matrix.loginAnomalyScore >= 80) reasons.push('login anomaly');
    if (matrix.transactionVelocity >= 80) reasons.push('transaction velocity');
    return reasons.join(', ') || 'composite threat score exceeded threshold';
  }
}
