/**
 * Phase 7 – Stress Testing Engine
 * Simulates: rate hike +200bps, NPL spike +5%, liquidity withdrawal 30%.
 * Non-destructive, read-only. Returns impact report.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type StressScenario = 'RATE_HIKE' | 'NPL_SPIKE' | 'LIQUIDITY_CRUNCH';

export interface StressTestResult {
  scenario: StressScenario;
  tenantId: string;
  runAt: string;
  assumptions: Record<string, unknown>;
  baselineMetrics: {
    totalLoanPortfolio: number;
    nplRatio: number;
    liquidityRatio: number;
    capitalAdequacyRatio: number;
    netInterestMargin: number;
  };
  stressedMetrics: {
    totalLoanPortfolio: number;
    nplRatio: number;
    liquidityRatio: number;
    capitalAdequacyRatio: number;
    netInterestMargin: number;
  };
  impact: {
    capitalAdequacyDelta: number;
    liquidityDelta: number;
    nplDelta: number;
    estimatedLoss: number;
    breachesThreshold: string[];
  };
  riskRating: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  recommendations: string[];
}

@Injectable()
export class StressTestService {
  private readonly logger = new Logger(StressTestService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Run a stress test scenario. Read-only – no data mutations.
   */
  async run(tenantId: string, scenario: StressScenario): Promise<StressTestResult> {
    this.logger.log(`[StressTest] Running ${scenario} for tenant ${tenantId}`);

    const baseline = await this.getBaselineMetrics(tenantId);

    let result: StressTestResult;
    switch (scenario) {
      case 'RATE_HIKE':
        result = await this.runRateHike(tenantId, baseline);
        break;
      case 'NPL_SPIKE':
        result = await this.runNplSpike(tenantId, baseline);
        break;
      case 'LIQUIDITY_CRUNCH':
        result = await this.runLiquidityCrunch(tenantId, baseline);
        break;
    }

    this.logger.log(`[StressTest] ${scenario} complete: riskRating=${result.riskRating}`);
    return result;
  }

  private async getBaselineMetrics(tenantId: string): Promise<StressTestResult['baselineMetrics']> {
    const latest = await this.prisma.sasraRatioSnapshot.findFirst({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });

    const loanAgg = await this.prisma.loan.aggregate({
      where: { tenantId, status: { in: ['ACTIVE', 'DISBURSED'] } },
      _sum: { outstandingBalance: true },
    });

    return {
      totalLoanPortfolio: Number(loanAgg._sum.outstandingBalance ?? 0),
      nplRatio: Number(latest?.portfolioQualityRatio ?? 0.03),
      liquidityRatio: Number(latest?.liquidityRatio ?? 0.20),
      capitalAdequacyRatio: Number(latest?.capitalAdequacyRatio ?? 0.12),
      netInterestMargin: 0.08, // Stub: 8% NIM
    };
  }

  private async runRateHike(
    tenantId: string,
    baseline: StressTestResult['baselineMetrics'],
  ): Promise<StressTestResult> {
    // +200bps rate hike: increases NPL (borrowers can't afford higher rates)
    // and reduces NIM compression on fixed-rate loans
    const rateHikeBps = 200;
    const nplIncrease = 0.02; // +2% NPL from rate shock
    const nimCompression = 0.015; // -1.5% NIM

    const stressedNplRatio = baseline.nplRatio + nplIncrease;
    const stressedNim = baseline.netInterestMargin - nimCompression;
    const estimatedLoss = baseline.totalLoanPortfolio * nplIncrease * 0.45; // 45% LGD

    const stressedCapital = baseline.capitalAdequacyRatio - (estimatedLoss / (baseline.totalLoanPortfolio * 1.2));

    const breaches: string[] = [];
    if (stressedCapital < 0.08) breaches.push('Capital adequacy below 8% SASRA minimum');
    if (stressedNplRatio > 0.10) breaches.push('NPL ratio exceeds 10% regulatory threshold');

    return {
      scenario: 'RATE_HIKE',
      tenantId,
      runAt: new Date().toISOString(),
      assumptions: { rateHikeBps, nplIncrease, nimCompression, lgd: 0.45 },
      baselineMetrics: baseline,
      stressedMetrics: {
        ...baseline,
        nplRatio: stressedNplRatio,
        capitalAdequacyRatio: Math.max(0, stressedCapital),
        netInterestMargin: stressedNim,
      },
      impact: {
        capitalAdequacyDelta: stressedCapital - baseline.capitalAdequacyRatio,
        liquidityDelta: 0,
        nplDelta: nplIncrease,
        estimatedLoss,
        breachesThreshold: breaches,
      },
      riskRating: this.calculateRiskRating(breaches.length, estimatedLoss, baseline.totalLoanPortfolio),
      recommendations: this.buildRecommendations('RATE_HIKE', breaches),
    };
  }

  private async runNplSpike(
    tenantId: string,
    baseline: StressTestResult['baselineMetrics'],
  ): Promise<StressTestResult> {
    // NPL spike +5%: sudden deterioration in loan quality
    const nplSpike = 0.05;
    const stressedNplRatio = baseline.nplRatio + nplSpike;
    const estimatedLoss = baseline.totalLoanPortfolio * nplSpike * 0.50; // 50% LGD for NPL

    const stressedCapital = baseline.capitalAdequacyRatio - (estimatedLoss / (baseline.totalLoanPortfolio * 1.2));
    const stressedLiquidity = baseline.liquidityRatio - 0.03; // Liquidity pressure from NPL

    const breaches: string[] = [];
    if (stressedCapital < 0.08) breaches.push('Capital adequacy below 8% SASRA minimum');
    if (stressedNplRatio > 0.15) breaches.push('NPL ratio exceeds 15% – critical threshold');
    if (stressedLiquidity < 0.15) breaches.push('Liquidity ratio below 15% SASRA minimum');

    return {
      scenario: 'NPL_SPIKE',
      tenantId,
      runAt: new Date().toISOString(),
      assumptions: { nplSpike, lgd: 0.50, liquidityPressure: 0.03 },
      baselineMetrics: baseline,
      stressedMetrics: {
        ...baseline,
        nplRatio: stressedNplRatio,
        capitalAdequacyRatio: Math.max(0, stressedCapital),
        liquidityRatio: Math.max(0, stressedLiquidity),
      },
      impact: {
        capitalAdequacyDelta: stressedCapital - baseline.capitalAdequacyRatio,
        liquidityDelta: -0.03,
        nplDelta: nplSpike,
        estimatedLoss,
        breachesThreshold: breaches,
      },
      riskRating: this.calculateRiskRating(breaches.length, estimatedLoss, baseline.totalLoanPortfolio),
      recommendations: this.buildRecommendations('NPL_SPIKE', breaches),
    };
  }

  private async runLiquidityCrunch(
    tenantId: string,
    baseline: StressTestResult['baselineMetrics'],
  ): Promise<StressTestResult> {
    // 30% deposit withdrawal: severe liquidity stress
    const withdrawalPct = 0.30;

    const totalDeposits = await this.prisma.transaction.aggregate({
      where: { tenantId, type: 'DEPOSIT', status: 'COMPLETED' },
      _sum: { amount: true },
    });

    const depositBase = Number(totalDeposits._sum.amount ?? 0);
    const withdrawalAmount = depositBase * withdrawalPct;
    const stressedLiquidity = baseline.liquidityRatio - withdrawalPct * 0.8;
    const estimatedLoss = withdrawalAmount * 0.05; // 5% fire-sale discount

    const breaches: string[] = [];
    if (stressedLiquidity < 0.15) breaches.push('Liquidity ratio below 15% SASRA minimum');
    if (stressedLiquidity < 0.05) breaches.push('CRITICAL: Liquidity below 5% – insolvency risk');

    return {
      scenario: 'LIQUIDITY_CRUNCH',
      tenantId,
      runAt: new Date().toISOString(),
      assumptions: { withdrawalPct, depositBase, fireSaleDiscount: 0.05 },
      baselineMetrics: baseline,
      stressedMetrics: {
        ...baseline,
        liquidityRatio: Math.max(0, stressedLiquidity),
      },
      impact: {
        capitalAdequacyDelta: 0,
        liquidityDelta: stressedLiquidity - baseline.liquidityRatio,
        nplDelta: 0,
        estimatedLoss,
        breachesThreshold: breaches,
      },
      riskRating: this.calculateRiskRating(breaches.length, estimatedLoss, baseline.totalLoanPortfolio),
      recommendations: this.buildRecommendations('LIQUIDITY_CRUNCH', breaches),
    };
  }

  private calculateRiskRating(
    breachCount: number,
    estimatedLoss: number,
    portfolio: number,
  ): StressTestResult['riskRating'] {
    const lossRatio = portfolio > 0 ? estimatedLoss / portfolio : 0;
    if (breachCount >= 2 || lossRatio > 0.15) return 'CRITICAL';
    if (breachCount >= 1 || lossRatio > 0.08) return 'HIGH';
    if (lossRatio > 0.03) return 'MEDIUM';
    return 'LOW';
  }

  private buildRecommendations(scenario: StressScenario, breaches: string[]): string[] {
    const recs: string[] = [];
    if (scenario === 'RATE_HIKE') {
      recs.push('Review fixed-rate loan portfolio exposure');
      recs.push('Increase loan loss provisions by 15-20%');
      if (breaches.length > 0) recs.push('Initiate capital raising plan immediately');
    } else if (scenario === 'NPL_SPIKE') {
      recs.push('Activate early warning system for at-risk borrowers');
      recs.push('Increase collection team capacity');
      if (breaches.length > 0) recs.push('Engage CBK/SASRA with remediation plan');
    } else {
      recs.push('Maintain minimum 20% liquid asset buffer');
      recs.push('Diversify funding sources (interbank, bonds)');
      if (breaches.length > 0) recs.push('Activate contingency funding plan');
    }
    return recs;
  }
}
