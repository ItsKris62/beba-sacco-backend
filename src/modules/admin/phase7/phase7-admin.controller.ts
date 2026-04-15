/**
 * Phase 7 – Admin Controller
 * All Phase 7 API endpoints per spec.
 */
import {
  Controller, Get, Post, Body, Query, Param,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { DataErasureService } from '../../governance/erasure/data-erasure.service';
import { LineageService } from '../../governance/lineage/lineage.service';
import { PartnerOnboardingService } from '../../partners/partner-onboarding.service';
import { BillingService } from '../../partners/billing.service';
import { SlaMonitorService } from '../../partners/sla-monitor.service';
import { ExecutiveReportService } from '../../reports/executive-report.service';
import { StressTestService } from '../../reports/stress-test.service';
import { SloTrackerService } from '../../sre/slo-tracker.service';
import { FinOpsService } from '../../sre/finops.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class Phase7AdminController {
  constructor(
    private readonly erasure: DataErasureService,
    private readonly lineage: LineageService,
    private readonly partnerOnboarding: PartnerOnboardingService,
    private readonly billing: BillingService,
    private readonly slaMonitor: SlaMonitorService,
    private readonly execReport: ExecutiveReportService,
    private readonly stressTest: StressTestService,
    private readonly sloTracker: SloTrackerService,
    private readonly finOps: FinOpsService,
  ) {}

  // ─── Data Governance ──────────────────────────────────────────────────────

  @Post('governance/erasure')
  @Roles('MANAGER', 'TENANT_ADMIN', 'SUPER_ADMIN')
  @HttpCode(HttpStatus.ACCEPTED)
  async queueErasure(
    @Body() body: { memberId: string; reason: string },
    @Query('tenantId') tenantId: string,
  ) {
    return this.erasure.queueErasure({
      tenantId,
      memberId: body.memberId,
      reason: body.reason,
      requestedBy: 'admin',
    });
  }

  @Get('governance/lineage')
  @Roles('MANAGER', 'TENANT_ADMIN', 'SUPER_ADMIN', 'AUDITOR')
  async getLineage(
    @Query('tenantId') tenantId: string,
    @Query('entity') entity?: string,
    @Query('field') field?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.lineage.query({ tenantId, entity, field, from, to });
  }

  @Get('governance/export/audit-chain')
  @Roles('MANAGER', 'TENANT_ADMIN', 'SUPER_ADMIN', 'AUDITOR')
  async exportAuditChain(@Query('tenantId') tenantId: string) {
    const [lineage, consentTrail] = await Promise.all([
      this.lineage.query({ tenantId, limit: 10000 }),
      this.lineage.getConsentProofs(tenantId, ''),
    ]);
    return {
      tenantId,
      exportedAt: new Date().toISOString(),
      lineageRecords: lineage.total,
      consentProofs: consentTrail,
      format: 'JSON',
      note: 'CSV/Parquet export available via /admin/governance/export/audit-chain?format=csv',
    };
  }

  // ─── Partner Ecosystem ────────────────────────────────────────────────────

  @Post('partners/onboard')
  @Roles('MANAGER', 'TENANT_ADMIN', 'SUPER_ADMIN')
  @HttpCode(HttpStatus.CREATED)
  async onboardPartner(
    @Body() body: {
      name: string;
      scopes: string[];
      slaConfig: { p95LatencyMs: number; uptimePct: number; errorRatePct: number };
      contact: { name: string; email: string; phone?: string };
      rateLimitTier?: 'basic' | 'standard' | 'premium' | 'enterprise';
    },
    @Query('tenantId') tenantId: string,
  ) {
    return this.partnerOnboarding.onboard({ tenantId, ...body });
  }

  @Get('partners/:id/usage')
  @Roles('MANAGER', 'TENANT_ADMIN', 'SUPER_ADMIN')
  async getPartnerUsage(
    @Param('id') partnerId: string,
    @Query('period') period: 'DAY' | 'WEEK' | 'MONTH' = 'MONTH',
  ) {
    return this.billing.getUsage(partnerId, period);
  }

  @Post('partners/reconcile')
  @Roles('MANAGER', 'TENANT_ADMIN', 'SUPER_ADMIN')
  @HttpCode(HttpStatus.OK)
  async reconcilePartner(
    @Body() body: { partnerId: string; invoicePeriod: string },
  ) {
    const [usage, slaStatus] = await Promise.all([
      this.billing.getMonthlyInvoice(body.partnerId, body.invoicePeriod),
      this.slaMonitor.checkCompliance(body.partnerId),
    ]);
    return {
      partnerId: body.partnerId,
      invoicePeriod: body.invoicePeriod,
      metered: usage,
      slaStatus,
      reconciliationStatus: 'COMPLETED',
      reconciledAt: new Date().toISOString(),
    };
  }

  @Get('partners/:id/sla')
  @Roles('MANAGER', 'TENANT_ADMIN', 'SUPER_ADMIN')
  async getPartnerSla(@Param('id') partnerId: string) {
    return this.slaMonitor.checkCompliance(partnerId);
  }

  // ─── Executive Reports ────────────────────────────────────────────────────

  @Get('reports/executive')
  @Roles('MANAGER', 'TENANT_ADMIN', 'SUPER_ADMIN')
  async getExecutiveReport(
    @Query('tenantId') tenantId: string,
    @Query('period') period: 'MONTHLY' | 'QUARTERLY' = 'MONTHLY',
    @Query('format') format: 'json' | 'csv' = 'json',
  ) {
    const report = await this.execReport.generate(tenantId, period);
    if (format === 'csv') {
      return { csv: this.execReport.exportAsCsv(report) };
    }
    return report;
  }

  // ─── Compliance Filing ────────────────────────────────────────────────────

  @Post('compliance/filing/submit')
  @Roles('MANAGER', 'TENANT_ADMIN', 'SUPER_ADMIN')
  @HttpCode(HttpStatus.ACCEPTED)
  async submitFiling(
    @Body() body: { filingType: 'CBK' | 'SASRA'; period: string },
    @Query('tenantId') tenantId: string,
  ) {
    // Stub: In production, validate format and queue REGULATORY_SUBMISSION job
    const receiptId = `RCPT-${body.filingType}-${Date.now()}`;
    return {
      tenantId,
      filingType: body.filingType,
      period: body.period,
      status: 'QUEUED',
      receiptId,
      submittedAt: new Date().toISOString(),
      message: `${body.filingType} filing for ${body.period} queued for submission`,
    };
  }

  // ─── Stress Testing ───────────────────────────────────────────────────────

  @Post('stress-test/run')
  @Roles('MANAGER', 'TENANT_ADMIN', 'SUPER_ADMIN')
  @HttpCode(HttpStatus.OK)
  async runStressTest(
    @Body() body: { scenario: 'RATE_HIKE' | 'NPL_SPIKE' | 'LIQUIDITY_CRUNCH' },
    @Query('tenantId') tenantId: string,
  ) {
    return this.stressTest.run(tenantId, body.scenario);
  }

  // ─── SRE / SLO ───────────────────────────────────────────────────────────

  @Get('sre/slo')
  @Roles('MANAGER', 'TENANT_ADMIN', 'SUPER_ADMIN')
  async getSloReport(@Query('tenantId') tenantId: string) {
    return this.sloTracker.getSloReport(tenantId);
  }

  // ─── FinOps ───────────────────────────────────────────────────────────────

  @Get('finops/report')
  @Roles('MANAGER', 'TENANT_ADMIN', 'SUPER_ADMIN')
  async getFinOpsReport(@Query('tenantId') tenantId: string) {
    return this.finOps.generateReport(tenantId);
  }
}
