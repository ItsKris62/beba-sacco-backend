import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { RealTimeAnalyticsService } from '../../analytics/sse/real-time-analytics.service';
import { BehavioralRiskScorerService } from '../../fraud/risk-scorer/behavioral-risk-scorer.service';
import { PolicyEngineService } from '../../compliance/policy-engine/policy-engine.service';
import { AuditChainService } from '../../audit/audit-chain.service';
import { FeatureFlagService } from '../feature-flags/feature-flag.service';
import { MultiRegionService } from '../../tenants/multi-region/multi-region.service';
import { CanaryService } from '../../deploy/canary/canary.service';

/**
 * Phase 6 Admin Controller
 *
 * Implements all Phase 6 API contracts:
 *  GET  /admin/analytics/real-time       – SSE stream of tenant metrics
 *  POST /admin/risk/score                – Behavioral risk scoring
 *  GET  /admin/compliance/policy-check   – OPA/JSON policy evaluation
 *  GET  /admin/audit/verify-chain        – Cryptographic audit chain
 *  POST /admin/feature-flags             – Hot-reload feature flags
 *  GET  /admin/data/residency-audit      – Data residency mapping
 *  GET  /admin/config                    – Live config
 *  POST /sandbox/reset                   – Sandbox reset
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'TENANT_ADMIN')
export class Phase6AdminController {
  constructor(
    private readonly analyticsService: RealTimeAnalyticsService,
    private readonly riskScorer: BehavioralRiskScorerService,
    private readonly policyEngine: PolicyEngineService,
    private readonly auditChain: AuditChainService,
    private readonly featureFlags: FeatureFlagService,
    private readonly multiRegion: MultiRegionService,
    private readonly canaryService: CanaryService,
  ) {}

  // ─── SSE: Real-Time Analytics ─────────────────────────────────────────────

  @Get('analytics/real-time')
  async streamAnalytics(@Req() req: Request, @Res() res: Response): Promise<void> {
    const tenantId = (req as Request & { tenant?: { id: string } }).tenant?.id;
    if (!tenantId) {
      res.status(400).json({ message: 'X-Tenant-ID required' });
      return;
    }

    // Check if client supports SSE
    const acceptHeader = req.headers['accept'] ?? '';
    if (!acceptHeader.includes('text/event-stream')) {
      // Fallback: return current snapshot as JSON
      const metrics = await this.analyticsService.computeMetrics(tenantId);
      res.json(metrics);
      return;
    }

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send initial snapshot
    const initial = await this.analyticsService.computeMetrics(tenantId);
    res.write(`data: ${JSON.stringify(initial)}\n\n`);

    // Subscribe to live updates
    const handler = (metrics: typeof initial) => {
      if (metrics.tenantId === tenantId) {
        res.write(`data: ${JSON.stringify(metrics)}\n\n`);
      }
    };

    this.analyticsService.onMetrics(handler);

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      this.analyticsService.offMetrics(handler);
    });
  }

  // ─── Risk Scoring ─────────────────────────────────────────────────────────

  @Post('risk/score')
  @HttpCode(HttpStatus.OK)
  async scoreRisk(
    @Req() req: Request,
    @Body() body: { memberId: string; context: 'LOAN_APPLY' | 'DEPOSIT' | 'LOGIN' | 'MANUAL' },
  ) {
    const tenantId = (req as Request & { tenant?: { id: string } }).tenant?.id ?? '';
    return this.riskScorer.evaluate(tenantId, body.memberId, body.context);
  }

  // ─── Policy Check ─────────────────────────────────────────────────────────

  @Get('compliance/policy-check')
  async policyCheck(
    @Req() req: Request,
    @Query('policy') policy?: string,
  ) {
    const tenantId = (req as Request & { tenant?: { id: string } }).tenant?.id ?? '';
    return this.policyEngine.runPolicyCheck(tenantId, policy);
  }

  // ─── Audit Chain Verification ─────────────────────────────────────────────

  @Get('audit/verify-chain')
  async verifyAuditChain(@Req() req: Request) {
    const tenantId = (req as Request & { tenant?: { id: string } }).tenant?.id ?? '';
    return this.auditChain.verifyChain(tenantId);
  }

  // ─── Feature Flags ────────────────────────────────────────────────────────

  @Post('feature-flags')
  @HttpCode(HttpStatus.OK)
  async upsertFeatureFlag(
    @Body() body: {
      key: string;
      rollout: number;
      tenantIds?: string[];
      roles?: string[];
      description?: string;
    },
  ) {
    return this.featureFlags.upsertFlag(body);
  }

  @Get('feature-flags')
  async listFeatureFlags() {
    return this.featureFlags.listFlags();
  }

  // ─── Data Residency Audit ─────────────────────────────────────────────────

  @Get('data/residency-audit')
  async residencyAudit(@Req() req: Request) {
    const tenantId = (req as Request & { tenant?: { id: string } }).tenant?.id ?? '';
    return this.multiRegion.getResidencyAudit(tenantId);
  }

  // ─── Live Config ──────────────────────────────────────────────────────────

  @Get('config')
  async getLiveConfig(@Req() req: Request) {
    const tenantId = (req as Request & { tenant?: { id: string } }).tenant?.id ?? '';
    return {
      tenantId,
      timestamp: new Date().toISOString(),
      config: {
        featureFlags: await this.featureFlags.listFlags(),
        region: await this.multiRegion.getTenantRegion(tenantId),
      },
    };
  }

  // ─── Canary Deployment Status ─────────────────────────────────────────────

  @Get('deploy/canary/status')
  async canaryStatus() {
    return this.canaryService.getLatestDeployment();
  }

  @Post('deploy/canary/rollback/:deploymentId')
  @HttpCode(HttpStatus.OK)
  async rollbackCanary(@Param('deploymentId') deploymentId: string) {
    return this.canaryService.triggerRollback(deploymentId, 'Manual rollback via API');
  }
}
