import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { LoanStatus, LoanStaging } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * CBK Monthly Return Generator – Phase 5
 *
 * Generates CBK (Central Bank of Kenya) monthly return CSV with standardized columns:
 *   LOAN_PORTFOLIO, NPL_RATIO, DEPOSIT_GROWTH, CAPITAL_ADEQUACY
 *
 * Returns are versioned by filing date to support amendments.
 * Format follows CBK Prudential Guidelines for SACCOs.
 */

const CBK_CSV_HEADERS = [
  'PERIOD',
  'INSTITUTION_CODE',
  'TOTAL_MEMBERS',
  'TOTAL_DEPOSITS',
  'TOTAL_SHARES',
  'LOAN_PORTFOLIO',
  'PERFORMING_LOANS',
  'WATCHLIST_LOANS',
  'NPL_AMOUNT',
  'NPL_RATIO',
  'TOTAL_PROVISIONS',
  'DEPOSIT_GROWTH',
  'CAPITAL_ADEQUACY',
  'LIQUIDITY_RATIO',
  'TOTAL_ASSETS',
  'CORE_CAPITAL',
  'TOTAL_INCOME',
  'TOTAL_EXPENSES',
  'NET_SURPLUS',
];

@Injectable()
export class CbkReturnService {
  private readonly logger = new Logger(CbkReturnService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /admin/compliance/cbk-return?period=YYYY-MM
   * Generates CBK monthly filing CSV.
   */
  async generateReturn(tenantId: string, period: string) {
    // Validate period format
    if (!/^\d{4}-\d{2}$/.test(period)) {
      throw new Error('Period must be in YYYY-MM format');
    }

    const [year, month] = period.split('-').map(Number);
    const periodStart = new Date(year, month - 1, 1);
    const periodEnd = new Date(year, month, 0, 23, 59, 59, 999);

    // Previous period for growth calculation
    const prevPeriodStart = new Date(year, month - 2, 1);
    const prevPeriodEnd = new Date(year, month - 1, 0, 23, 59, 59, 999);

    // Fetch all required data
    const [
      totalMembers,
      totalDeposits,
      totalShares,
      performingLoans,
      watchlistLoans,
      nplLoans,
      totalProvisions,
      prevDeposits,
      totalIncome,
      totalExpenses,
    ] = await Promise.all([
      // Total active members
      this.prisma.member.count({
        where: { tenantId, isActive: true, deletedAt: null },
      }),

      // Total FOSA deposits
      this.prisma.account.aggregate({
        where: { tenantId, accountType: 'FOSA', isActive: true },
        _sum: { balance: true },
      }),

      // Total BOSA shares
      this.prisma.account.aggregate({
        where: { tenantId, accountType: 'BOSA', isActive: true },
        _sum: { balance: true },
      }),

      // Performing loans
      this.prisma.loan.aggregate({
        where: { tenantId, staging: LoanStaging.PERFORMING, status: { in: [LoanStatus.ACTIVE, LoanStatus.DISBURSED] } },
        _sum: { outstandingBalance: true },
        _count: true,
      }),

      // Watchlist loans
      this.prisma.loan.aggregate({
        where: { tenantId, staging: LoanStaging.WATCHLIST },
        _sum: { outstandingBalance: true },
        _count: true,
      }),

      // NPL loans
      this.prisma.loan.aggregate({
        where: { tenantId, staging: LoanStaging.NPL },
        _sum: { outstandingBalance: true },
        _count: true,
      }),

      // Total ECL provisions (latest calculation)
      this.prisma.provisioningEntry.aggregate({
        where: {
          tenantId,
          calculationDate: { gte: periodStart, lte: periodEnd },
        },
        _sum: { eclAmount: true },
      }),

      // Previous period deposits (for growth calculation)
      this.prisma.account.aggregate({
        where: { tenantId, accountType: 'FOSA', isActive: true },
        _sum: { balance: true },
      }),

      // Total income (deposits + repayments in period)
      this.prisma.transaction.aggregate({
        where: {
          tenantId,
          type: { in: ['DEPOSIT', 'LOAN_REPAYMENT', 'INTEREST_ACCRUAL'] },
          status: 'COMPLETED',
          createdAt: { gte: periodStart, lte: periodEnd },
        },
        _sum: { amount: true },
      }),

      // Total expenses (withdrawals + disbursements in period)
      this.prisma.transaction.aggregate({
        where: {
          tenantId,
          type: { in: ['WITHDRAWAL', 'LOAN_DISBURSEMENT'] },
          status: 'COMPLETED',
          createdAt: { gte: periodStart, lte: periodEnd },
        },
        _sum: { amount: true },
      }),
    ]);

    // Calculate metrics
    const depositsVal = new Decimal(totalDeposits._sum.balance?.toString() ?? '0');
    const sharesVal = new Decimal(totalShares._sum.balance?.toString() ?? '0');
    const performingVal = new Decimal(performingLoans._sum.outstandingBalance?.toString() ?? '0');
    const watchlistVal = new Decimal(watchlistLoans._sum.outstandingBalance?.toString() ?? '0');
    const nplVal = new Decimal(nplLoans._sum.outstandingBalance?.toString() ?? '0');
    const provisionsVal = new Decimal(totalProvisions._sum.eclAmount?.toString() ?? '0');
    const prevDepositsVal = new Decimal(prevDeposits._sum.balance?.toString() ?? '0');
    const incomeVal = new Decimal(totalIncome._sum.amount?.toString() ?? '0');
    const expensesVal = new Decimal(totalExpenses._sum.amount?.toString() ?? '0');

    const loanPortfolio = performingVal.plus(watchlistVal).plus(nplVal);
    const nplRatio = loanPortfolio.gt(0) ? nplVal.dividedBy(loanPortfolio) : new Decimal(0);
    const depositGrowth = prevDepositsVal.gt(0)
      ? depositsVal.minus(prevDepositsVal).dividedBy(prevDepositsVal)
      : new Decimal(0);
    const totalAssets = depositsVal.plus(loanPortfolio);
    const capitalAdequacy = totalAssets.gt(0) ? sharesVal.dividedBy(totalAssets) : new Decimal(0);
    const liquidityRatio = depositsVal.gt(0) ? depositsVal.dividedBy(depositsVal) : new Decimal(1);
    const netSurplus = incomeVal.minus(expensesVal);

    // Build CSV row
    const institutionCode = `SACCO-${tenantId.slice(0, 8).toUpperCase()}`;
    const row = [
      period,
      institutionCode,
      totalMembers,
      depositsVal.toFixed(4),
      sharesVal.toFixed(4),
      loanPortfolio.toFixed(4),
      performingVal.toFixed(4),
      watchlistVal.toFixed(4),
      nplVal.toFixed(4),
      nplRatio.toFixed(6),
      provisionsVal.toFixed(4),
      depositGrowth.toFixed(6),
      capitalAdequacy.toFixed(6),
      liquidityRatio.toFixed(6),
      totalAssets.toFixed(4),
      sharesVal.toFixed(4),
      incomeVal.toFixed(4),
      expensesVal.toFixed(4),
      netSurplus.toFixed(4),
    ];

    const csvContent = [CBK_CSV_HEADERS.join(','), row.join(',')].join('\n');

    // Determine version (increment if same period exists)
    const existingReturns = await this.prisma.cbkReturn.findMany({
      where: { tenantId, period },
      orderBy: { version: 'desc' },
      take: 1,
    });
    const version = existingReturns.length > 0 ? existingReturns[0].version + 1 : 1;

    // Save return record
    const cbkReturn = await this.prisma.cbkReturn.create({
      data: {
        tenantId,
        period,
        version,
        csvPayload: csvContent,
        loanPortfolio: loanPortfolio.toString(),
        nplRatio: nplRatio.toString(),
        depositGrowth: depositGrowth.toString(),
        capitalAdequacy: capitalAdequacy.toString(),
      },
    });

    this.logger.log(`CBK return generated: period=${period} version=${version} tenant=${tenantId}`);

    return {
      returnId: cbkReturn.id,
      period,
      version,
      filingDate: cbkReturn.filingDate.toISOString(),
      metrics: {
        loanPortfolio: loanPortfolio.toNumber(),
        nplRatio: nplRatio.toNumber(),
        depositGrowth: depositGrowth.toNumber(),
        capitalAdequacy: capitalAdequacy.toNumber(),
        totalMembers,
        totalAssets: totalAssets.toNumber(),
      },
      csv: csvContent,
    };
  }

  /**
   * Get historical CBK returns for a tenant.
   */
  async getReturns(tenantId: string, limit = 12) {
    return this.prisma.cbkReturn.findMany({
      where: { tenantId },
      orderBy: [{ period: 'desc' }, { version: 'desc' }],
      take: limit,
      select: {
        id: true,
        period: true,
        version: true,
        loanPortfolio: true,
        nplRatio: true,
        depositGrowth: true,
        capitalAdequacy: true,
        filingDate: true,
        createdAt: true,
      },
    });
  }
}
