import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Decimal } from 'decimal.js';
import { LoanStatus, LoanStaging } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../common/services/redis.service';

/**
 * IFRS 9 Expected Credit Loss (ECL) Calculator – Phase 5
 *
 * Calculates ECL = PD × LGD × EAD for each active loan daily.
 *
 * Probability of Default (PD):
 *   - PERFORMING:  2% (historical default rate for current loans)
 *   - WATCHLIST:  15% (elevated risk, 30–89 days arrears)
 *   - NPL:        60% (non-performing, ≥90 days arrears)
 *
 * Loss Given Default (LGD):
 *   - Unsecured SACCO loans: 45% (CBK guideline for unsecured)
 *   - Secured (with guarantors covering >80%): 25%
 *
 * Exposure at Default (EAD):
 *   - Outstanding balance + accrued interest
 *
 * Macro-economic adjustment factor:
 *   - Default: 1.0 (neutral)
 *   - Can be adjusted based on GDP growth, inflation, unemployment data
 *
 * Results are posted to ProvisioningEntry table and drive dashboard metrics.
 */

// ── Default PD rates by staging (SASRA/CBK aligned) ─────────────────────────
const PD_RATES: Record<string, number> = {
  PERFORMING: 0.02,   // 2%
  WATCHLIST: 0.15,    // 15%
  NPL: 0.60,          // 60%
};

// ── Default LGD rates ────────────────────────────────────────────────────────
const LGD_UNSECURED = 0.45;  // 45% for unsecured loans
const LGD_SECURED = 0.25;    // 25% for loans with adequate guarantor coverage

// ── Guarantee coverage threshold for "secured" classification ────────────────
const GUARANTEE_COVERAGE_THRESHOLD = 0.80; // 80% of principal

@Injectable()
export class Ifrs9EclService {
  private readonly logger = new Logger(Ifrs9EclService.name);
  private readonly LOCK_TTL = 90_000; // 25 hours

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Daily cron: Calculate ECL for all active loans across all tenants.
   * Runs at 2:00 AM EAT (UTC+3) daily.
   */
  @Cron('0 2 * * *', { timeZone: 'Africa/Nairobi' })
  async runDailyEclCalculation(): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    this.logger.log(`Starting daily IFRS 9 ECL calculation for ${today}`);

    // Get all active tenants
    const tenants = await this.prisma.tenant.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });

    for (const tenant of tenants) {
      try {
        await this.calculateEclForTenant(tenant.id, today);
      } catch (err) {
        this.logger.error(`ECL calculation failed for tenant ${tenant.id}`, err);
      }
    }
  }

  /**
   * Calculate ECL for all active loans in a tenant.
   * Idempotent: uses Redis lock + unique constraint on (tenantId, loanId, calculationDate).
   */
  async calculateEclForTenant(
    tenantId: string,
    calculationDate: string,
    macroAdjustment = 1.0,
  ): Promise<{
    processed: number;
    skipped: number;
    totalEcl: number;
    byStaging: Record<string, { count: number; ecl: number }>;
  }> {
    const lockKey = `ecl:${tenantId}:${calculationDate}`;
    const locked = await this.redis.set(lockKey, '1', this.LOCK_TTL, true);
    if (!locked) {
      this.logger.warn(`ECL already calculated for tenant=${tenantId} date=${calculationDate}`);
      return { processed: 0, skipped: 0, totalEcl: 0, byStaging: {} };
    }

    const dateObj = new Date(calculationDate);
    const activeStatuses: LoanStatus[] = [LoanStatus.ACTIVE, LoanStatus.DISBURSED, LoanStatus.DEFAULTED];

    const loans = await this.prisma.loan.findMany({
      where: {
        tenantId,
        status: { in: activeStatuses },
      },
      include: {
        guarantors: {
          where: { status: 'ACCEPTED' },
          select: { guaranteedAmount: true },
        },
      },
    });

    let processed = 0;
    let skipped = 0;
    let totalEcl = new Decimal(0);
    const byStaging: Record<string, { count: number; ecl: number }> = {};

    for (const loan of loans) {
      try {
        // Check if already calculated for this date (idempotency)
        const existing = await this.prisma.provisioningEntry.findUnique({
          where: {
            tenantId_loanId_calculationDate: {
              tenantId,
              loanId: loan.id,
              calculationDate: dateObj,
            },
          },
        });

        if (existing) {
          skipped++;
          continue;
        }

        // Calculate PD based on staging
        const pd = new Decimal(PD_RATES[loan.staging] ?? PD_RATES.PERFORMING);

        // Calculate LGD based on guarantor coverage
        const totalGuaranteed = loan.guarantors.reduce(
          (sum, g) => sum.plus(g.guaranteedAmount.toString()),
          new Decimal(0),
        );
        const principal = new Decimal(loan.principalAmount.toString());
        const coverageRatio = principal.gt(0)
          ? totalGuaranteed.dividedBy(principal).toNumber()
          : 0;
        const lgd = new Decimal(
          coverageRatio >= GUARANTEE_COVERAGE_THRESHOLD ? LGD_SECURED : LGD_UNSECURED,
        );

        // EAD = outstanding balance
        const ead = new Decimal(loan.outstandingBalance.toString());

        // ECL = PD × LGD × EAD × macroAdjustment
        const macro = new Decimal(macroAdjustment);
        const eclAmount = pd.times(lgd).times(ead).times(macro).toDecimalPlaces(4);

        // Store provisioning entry
        await this.prisma.provisioningEntry.create({
          data: {
            tenantId,
            loanId: loan.id,
            calculationDate: dateObj,
            staging: loan.staging,
            pd: pd.toDecimalPlaces(6).toString(),
            lgd: lgd.toDecimalPlaces(6).toString(),
            ead: ead.toDecimalPlaces(4).toString(),
            eclAmount: eclAmount.toString(),
            macroAdjustment: macro.toDecimalPlaces(4).toString(),
          },
        });

        totalEcl = totalEcl.plus(eclAmount);
        processed++;

        // Aggregate by staging
        const stagingKey = loan.staging;
        if (!byStaging[stagingKey]) {
          byStaging[stagingKey] = { count: 0, ecl: 0 };
        }
        byStaging[stagingKey].count++;
        byStaging[stagingKey].ecl += eclAmount.toNumber();
      } catch (err) {
        this.logger.error(`ECL calculation failed for loan ${loan.id}`, err);
        skipped++;
      }
    }

    this.logger.log(
      `ECL calculation complete: tenant=${tenantId} date=${calculationDate} ` +
      `processed=${processed} skipped=${skipped} totalECL=${totalEcl.toFixed(4)}`,
    );

    return {
      processed,
      skipped,
      totalEcl: totalEcl.toNumber(),
      byStaging,
    };
  }

  /**
   * GET /admin/compliance/ifrs9-ecl
   * Returns provisioning entries for a given date and optional staging filter.
   */
  async getProvisioningEntries(
    tenantId: string,
    date?: string,
    staging?: string,
  ) {
    const calculationDate = date ? new Date(date) : new Date();
    calculationDate.setUTCHours(0, 0, 0, 0);

    const entries = await this.prisma.provisioningEntry.findMany({
      where: {
        tenantId,
        calculationDate,
        ...(staging && { staging: staging as LoanStaging }),
      },
      orderBy: { eclAmount: 'desc' },
    });

    // Aggregate summary
    const summary = {
      date: calculationDate.toISOString().split('T')[0],
      totalEntries: entries.length,
      totalEcl: entries.reduce((sum, e) => sum + parseFloat(e.eclAmount.toString()), 0),
      byStaging: {} as Record<string, { count: number; totalEcl: number; avgPd: number }>,
    };

    for (const entry of entries) {
      const key = entry.staging;
      if (!summary.byStaging[key]) {
        summary.byStaging[key] = { count: 0, totalEcl: 0, avgPd: 0 };
      }
      summary.byStaging[key].count++;
      summary.byStaging[key].totalEcl += parseFloat(entry.eclAmount.toString());
      summary.byStaging[key].avgPd += parseFloat(entry.pd.toString());
    }

    // Calculate averages
    for (const key of Object.keys(summary.byStaging)) {
      if (summary.byStaging[key].count > 0) {
        summary.byStaging[key].avgPd /= summary.byStaging[key].count;
      }
    }

    return { summary, entries };
  }

  /**
   * Get ECL trend over time for dashboard charts.
   */
  async getEclTrend(tenantId: string, days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const entries = await this.prisma.provisioningEntry.groupBy({
      by: ['calculationDate', 'staging'],
      where: {
        tenantId,
        calculationDate: { gte: startDate },
      },
      _sum: { eclAmount: true },
      _count: true,
      orderBy: { calculationDate: 'asc' },
    });

    return entries.map((e) => ({
      date: e.calculationDate.toISOString().split('T')[0],
      staging: e.staging,
      totalEcl: parseFloat(e._sum.eclAmount?.toString() ?? '0'),
      loanCount: e._count,
    }));
  }
}
