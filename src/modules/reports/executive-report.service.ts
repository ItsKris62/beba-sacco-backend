/**
 * Phase 7 – Board-Ready Automated Reports
 * Generates PDF/CSV with portfolio growth, NPL trends, liquidity ratios,
 * provisioning coverage, deposit inflow, partner revenue.
 * Scheduled via BullMQ cron.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_NAMES } from '../queue/queue.constants';

export type ReportPeriod = 'MONTHLY' | 'QUARTERLY';

export interface ExecutiveReport {
  tenantId: string;
  period: string;
  periodType: ReportPeriod;
  generatedAt: string;
  portfolioGrowth: {
    totalLoans: number;
    totalDisbursed: number;
    growthPct: number;
  };
  nplTrends: {
    nplAmount: number;
    nplRatio: number;
    trend: 'IMPROVING' | 'STABLE' | 'DETERIORATING';
  };
  liquidityRatios: {
    liquidityRatio: number;
    capitalAdequacyRatio: number;
    sasraCompliant: boolean;
  };
  provisioningCoverage: {
    totalEcl: number;
    coverageRatio: number;
  };
  depositInflow: {
    totalDeposits: number;
    netInflow: number;
    memberCount: number;
  };
  partnerRevenue: {
    totalRevenue: number;
    activePartners: number;
    topPartner?: string;
  };
  summary: string;
}

@Injectable()
export class ExecutiveReportService {
  private readonly logger = new Logger(ExecutiveReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.EXECUTIVE_REPORT) private readonly reportQueue: Queue,
  ) {}

  /**
   * Generate an executive report for a tenant and period.
   */
  async generate(tenantId: string, periodType: ReportPeriod): Promise<ExecutiveReport> {
    const period = this.getPeriodLabel(periodType);
    const { start, end } = this.getPeriodDates(periodType);

    this.logger.log(`[ExecReport] Generating ${periodType} report for tenant ${tenantId}`);

    const [portfolioGrowth, nplTrends, liquidityRatios, provisioningCoverage, depositInflow, partnerRevenue] =
      await Promise.all([
        this.getPortfolioGrowth(tenantId, start, end),
        this.getNplTrends(tenantId),
        this.getLiquidityRatios(tenantId),
        this.getProvisioningCoverage(tenantId, start, end),
        this.getDepositInflow(tenantId, start, end),
        this.getPartnerRevenue(tenantId),
      ]);

    const report: ExecutiveReport = {
      tenantId,
      period,
      periodType,
      generatedAt: new Date().toISOString(),
      portfolioGrowth,
      nplTrends,
      liquidityRatios,
      provisioningCoverage,
      depositInflow,
      partnerRevenue,
      summary: this.buildSummary(portfolioGrowth, nplTrends, liquidityRatios),
    };

    // Persist report
    await this.prisma.executiveReport.upsert({
      where: { tenantId_period_periodType: { tenantId, period, periodType } },
      create: {
        tenantId,
        period,
        periodType,
        reportData: report as unknown as Record<string, unknown>,
        generatedAt: new Date(),
      },
      update: {
        reportData: report as unknown as Record<string, unknown>,
        generatedAt: new Date(),
      },
    });

    return report;
  }

  /**
   * Queue a scheduled report generation.
   */
  async scheduleReport(tenantId: string, periodType: ReportPeriod): Promise<string> {
    const job = await this.reportQueue.add(
      'generate-executive-report',
      { tenantId, periodType },
      {
        jobId: `exec-report-${tenantId}-${periodType}-${Date.now()}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
      },
    );
    return job.id ?? '';
  }

  /**
   * Export report as CSV string.
   */
  exportAsCsv(report: ExecutiveReport): string {
    const rows = [
      ['Metric', 'Value', 'Period'],
      ['Total Loans (KES)', report.portfolioGrowth.totalLoans.toString(), report.period],
      ['Portfolio Growth (%)', report.portfolioGrowth.growthPct.toFixed(2), report.period],
      ['NPL Amount (KES)', report.nplTrends.nplAmount.toString(), report.period],
      ['NPL Ratio (%)', (report.nplTrends.nplRatio * 100).toFixed(2), report.period],
      ['Liquidity Ratio', report.liquidityRatios.liquidityRatio.toFixed(4), report.period],
      ['Capital Adequacy Ratio', report.liquidityRatios.capitalAdequacyRatio.toFixed(4), report.period],
      ['Total ECL (KES)', report.provisioningCoverage.totalEcl.toString(), report.period],
      ['Coverage Ratio', report.provisioningCoverage.coverageRatio.toFixed(4), report.period],
      ['Total Deposits (KES)', report.depositInflow.totalDeposits.toString(), report.period],
      ['Active Members', report.depositInflow.memberCount.toString(), report.period],
      ['Partner Revenue (KES)', report.partnerRevenue.totalRevenue.toString(), report.period],
      ['Active Partners', report.partnerRevenue.activePartners.toString(), report.period],
    ];

    return rows.map((r) => r.join(',')).join('\n');
  }

  private async getPortfolioGrowth(
    tenantId: string,
    start: Date,
    end: Date,
  ): Promise<ExecutiveReport['portfolioGrowth']> {
    const loans = await this.prisma.loan.aggregate({
      where: { tenantId, disbursedAt: { gte: start, lte: end } },
      _sum: { principalAmount: true },
      _count: { id: true },
    });

    const prevStart = new Date(start.getTime() - (end.getTime() - start.getTime()));
    const prevLoans = await this.prisma.loan.aggregate({
      where: { tenantId, disbursedAt: { gte: prevStart, lte: start } },
      _sum: { principalAmount: true },
    });

    const current = Number(loans._sum.principalAmount ?? 0);
    const previous = Number(prevLoans._sum.principalAmount ?? 0);
    const growthPct = previous > 0 ? ((current - previous) / previous) * 100 : 0;

    return {
      totalLoans: loans._count.id,
      totalDisbursed: current,
      growthPct,
    };
  }

  private async getNplTrends(tenantId: string): Promise<ExecutiveReport['nplTrends']> {
    const latest = await this.prisma.sasraRatioSnapshot.findFirst({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });

    const prev = await this.prisma.sasraRatioSnapshot.findFirst({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      skip: 1,
    });

    const nplRatio = Number(latest?.portfolioQualityRatio ?? 0);
    const prevRatio = Number(prev?.portfolioQualityRatio ?? 0);

    let trend: 'IMPROVING' | 'STABLE' | 'DETERIORATING' = 'STABLE';
    if (nplRatio < prevRatio - 0.005) trend = 'IMPROVING';
    else if (nplRatio > prevRatio + 0.005) trend = 'DETERIORATING';

    return {
      nplAmount: Number(latest?.nplAmount ?? 0),
      nplRatio,
      trend,
    };
  }

  private async getLiquidityRatios(tenantId: string): Promise<ExecutiveReport['liquidityRatios']> {
    const latest = await this.prisma.sasraRatioSnapshot.findFirst({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });

    const liquidityRatio = Number(latest?.liquidityRatio ?? 0);
    const capitalAdequacyRatio = Number(latest?.capitalAdequacyRatio ?? 0);

    return {
      liquidityRatio,
      capitalAdequacyRatio,
      sasraCompliant: liquidityRatio >= 0.15 && capitalAdequacyRatio >= 0.08,
    };
  }

  private async getProvisioningCoverage(
    tenantId: string,
    start: Date,
    end: Date,
  ): Promise<ExecutiveReport['provisioningCoverage']> {
    const ecl = await this.prisma.provisioningEntry.aggregate({
      where: { tenantId, calculationDate: { gte: start, lte: end } },
      _sum: { eclAmount: true, ead: true },
    });

    const totalEcl = Number(ecl._sum.eclAmount ?? 0);
    const totalEad = Number(ecl._sum.ead ?? 0);
    const coverageRatio = totalEad > 0 ? totalEcl / totalEad : 0;

    return { totalEcl, coverageRatio };
  }

  private async getDepositInflow(
    tenantId: string,
    start: Date,
    end: Date,
  ): Promise<ExecutiveReport['depositInflow']> {
    const deposits = await this.prisma.transaction.aggregate({
      where: { tenantId, type: 'DEPOSIT', status: 'COMPLETED', createdAt: { gte: start, lte: end } },
      _sum: { amount: true },
      _count: { id: true },
    });

    const withdrawals = await this.prisma.transaction.aggregate({
      where: { tenantId, type: 'WITHDRAWAL', status: 'COMPLETED', createdAt: { gte: start, lte: end } },
      _sum: { amount: true },
    });

    const memberCount = await this.prisma.member.count({
      where: { tenantId, isActive: true },
    });

    return {
      totalDeposits: Number(deposits._sum.amount ?? 0),
      netInflow: Number(deposits._sum.amount ?? 0) - Number(withdrawals._sum.amount ?? 0),
      memberCount,
    };
  }

  private async getPartnerRevenue(tenantId: string): Promise<ExecutiveReport['partnerRevenue']> {
    const snapshots = await this.prisma.partnerUsageSnapshot.findMany({
      where: { partner: { tenantId } },
      orderBy: { totalCostKes: 'desc' },
    });

    const totalRevenue = snapshots.reduce((sum, s) => sum + Number(s.totalCostKes), 0);
    const activePartners = await this.prisma.partner.count({
      where: { tenantId, status: 'ACTIVE' },
    });

    return {
      totalRevenue,
      activePartners,
      topPartner: snapshots[0]?.partnerId,
    };
  }

  private buildSummary(
    portfolio: ExecutiveReport['portfolioGrowth'],
    npl: ExecutiveReport['nplTrends'],
    liquidity: ExecutiveReport['liquidityRatios'],
  ): string {
    const parts: string[] = [];
    parts.push(`Portfolio grew by ${portfolio.growthPct.toFixed(1)}% with ${portfolio.totalLoans} loans disbursed.`);
    parts.push(`NPL ratio is ${(npl.nplRatio * 100).toFixed(2)}% (${npl.trend}).`);
    parts.push(`Liquidity ratio: ${(liquidity.liquidityRatio * 100).toFixed(2)}%. SASRA: ${liquidity.sasraCompliant ? 'COMPLIANT' : 'NON-COMPLIANT'}.`);
    return parts.join(' ');
  }

  private getPeriodLabel(type: ReportPeriod): string {
    const now = new Date();
    if (type === 'MONTHLY') {
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    const quarter = Math.ceil((now.getMonth() + 1) / 3);
    return `${now.getFullYear()}-Q${quarter}`;
  }

  private getPeriodDates(type: ReportPeriod): { start: Date; end: Date } {
    const now = new Date();
    if (type === 'MONTHLY') {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start, end };
    }
    // Quarterly: last quarter
    const quarter = Math.ceil((now.getMonth() + 1) / 3);
    const prevQuarter = quarter === 1 ? 4 : quarter - 1;
    const year = quarter === 1 ? now.getFullYear() - 1 : now.getFullYear();
    const start = new Date(year, (prevQuarter - 1) * 3, 1);
    const end = new Date(year, prevQuarter * 3, 0);
    return { start, end };
  }
}
