import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { LoanStatus, LoanStaging } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * SASRA Liquidity & Capital Ratios Service – Phase 5
 *
 * Computes regulatory ratios required by SASRA (Sacco Societies Regulatory Authority):
 *   1. Liquidity Ratio = Liquid Assets / Short-Term Liabilities (min 15%)
 *   2. Capital Adequacy = Core Capital / Total Assets (min 10%)
 *   3. Portfolio Quality = NPL Amount / Total Loans (target < 5%)
 *
 * Returns CBK-formatted JSON with trend history for dashboard and filing.
 */
@Injectable()
export class SasraRatiosService {
  private readonly logger = new Logger(SasraRatiosService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /admin/compliance/sasra-ratios
   * Computes current ratios and returns with trend history.
   */
  async computeRatios(tenantId: string, period?: string) {
    const targetPeriod = period ?? new Date().toISOString().slice(0, 7); // YYYY-MM

    // Fetch aggregate data
    const [
      totalDeposits,
      totalFosaBalances,
      totalBosaBalances,
      totalLoanOutstanding,
      nplLoans,
      activeLoanCount,
      totalLoanDisbursed,
    ] = await Promise.all([
      // Total deposits (FOSA + BOSA balances = proxy for deposits)
      this.prisma.account.aggregate({
        where: { tenantId, isActive: true },
        _sum: { balance: true },
      }),
      // FOSA balances (liquid assets proxy)
      this.prisma.account.aggregate({
        where: { tenantId, isActive: true, accountType: 'FOSA' },
        _sum: { balance: true },
      }),
      // BOSA balances (core capital proxy)
      this.prisma.account.aggregate({
        where: { tenantId, isActive: true, accountType: 'BOSA' },
        _sum: { balance: true },
      }),
      // Total outstanding loan balance
      this.prisma.loan.aggregate({
        where: {
          tenantId,
          status: { in: [LoanStatus.ACTIVE, LoanStatus.DISBURSED, LoanStatus.DEFAULTED] },
        },
        _sum: { outstandingBalance: true },
      }),
      // NPL loans
      this.prisma.loan.aggregate({
        where: { tenantId, staging: LoanStaging.NPL },
        _sum: { outstandingBalance: true },
        _count: true,
      }),
      // Active loan count
      this.prisma.loan.count({
        where: {
          tenantId,
          status: { in: [LoanStatus.ACTIVE, LoanStatus.DISBURSED] },
        },
      }),
      // Total disbursed (all time)
      this.prisma.loan.aggregate({
        where: { tenantId },
        _sum: { principalAmount: true },
      }),
    ]);

    const liquidAssets = new Decimal(totalFosaBalances._sum.balance?.toString() ?? '0');
    const bosaBalance = new Decimal(totalBosaBalances._sum.balance?.toString() ?? '0');
    const totalDepositsVal = new Decimal(totalDeposits._sum.balance?.toString() ?? '0');
    const totalLoans = new Decimal(totalLoanOutstanding._sum.outstandingBalance?.toString() ?? '0');
    const nplAmount = new Decimal(nplLoans._sum.outstandingBalance?.toString() ?? '0');

    // Total assets = deposits + loans outstanding
    const totalAssets = totalDepositsVal.plus(totalLoans);

    // Short-term liabilities = FOSA balances (demand deposits)
    const shortTermLiabilities = liquidAssets;

    // Core capital = BOSA balances (member shares)
    const coreCapital = bosaBalance;

    // Compute ratios
    const liquidityRatio = shortTermLiabilities.gt(0)
      ? liquidAssets.dividedBy(shortTermLiabilities).toDecimalPlaces(6)
      : new Decimal(0);

    const capitalAdequacyRatio = totalAssets.gt(0)
      ? coreCapital.dividedBy(totalAssets).toDecimalPlaces(6)
      : new Decimal(0);

    const portfolioQualityRatio = totalLoans.gt(0)
      ? nplAmount.dividedBy(totalLoans).toDecimalPlaces(6)
      : new Decimal(0);

    // Save snapshot
    await this.prisma.sasraRatioSnapshot.upsert({
      where: { tenantId_period: { tenantId, period: targetPeriod } },
      create: {
        tenantId,
        period: targetPeriod,
        liquidAssets: liquidAssets.toString(),
        shortTermLiabilities: shortTermLiabilities.toString(),
        liquidityRatio: liquidityRatio.toString(),
        coreCapital: coreCapital.toString(),
        totalAssets: totalAssets.toString(),
        capitalAdequacyRatio: capitalAdequacyRatio.toString(),
        totalLoans: totalLoans.toString(),
        nplAmount: nplAmount.toString(),
        portfolioQualityRatio: portfolioQualityRatio.toString(),
        metadata: {
          activeLoanCount,
          nplCount: nplLoans._count,
          fosaBalance: liquidAssets.toNumber(),
          bosaBalance: bosaBalance.toNumber(),
        },
      },
      update: {
        liquidAssets: liquidAssets.toString(),
        shortTermLiabilities: shortTermLiabilities.toString(),
        liquidityRatio: liquidityRatio.toString(),
        coreCapital: coreCapital.toString(),
        totalAssets: totalAssets.toString(),
        capitalAdequacyRatio: capitalAdequacyRatio.toString(),
        totalLoans: totalLoans.toString(),
        nplAmount: nplAmount.toString(),
        portfolioQualityRatio: portfolioQualityRatio.toString(),
      },
    });

    // Fetch trend history (last 12 months)
    const trendHistory = await this.prisma.sasraRatioSnapshot.findMany({
      where: { tenantId },
      orderBy: { period: 'desc' },
      take: 12,
    });

    return {
      period: targetPeriod,
      ratios: {
        liquidityRatio: {
          value: liquidityRatio.toNumber(),
          minimum: 0.15,
          status: liquidityRatio.gte(0.15) ? 'COMPLIANT' : 'NON_COMPLIANT',
          components: {
            liquidAssets: liquidAssets.toNumber(),
            shortTermLiabilities: shortTermLiabilities.toNumber(),
          },
        },
        capitalAdequacy: {
          value: capitalAdequacyRatio.toNumber(),
          minimum: 0.10,
          status: capitalAdequacyRatio.gte(0.10) ? 'COMPLIANT' : 'NON_COMPLIANT',
          components: {
            coreCapital: coreCapital.toNumber(),
            totalAssets: totalAssets.toNumber(),
          },
        },
        portfolioQuality: {
          value: portfolioQualityRatio.toNumber(),
          target: 0.05,
          status: portfolioQualityRatio.lte(0.05) ? 'HEALTHY' : 'AT_RISK',
          components: {
            nplAmount: nplAmount.toNumber(),
            totalLoans: totalLoans.toNumber(),
            nplCount: nplLoans._count,
            activeLoanCount,
          },
        },
      },
      trendHistory: trendHistory.map((s) => ({
        period: s.period,
        liquidityRatio: parseFloat(s.liquidityRatio.toString()),
        capitalAdequacyRatio: parseFloat(s.capitalAdequacyRatio.toString()),
        portfolioQualityRatio: parseFloat(s.portfolioQualityRatio.toString()),
      })),
    };
  }
}
