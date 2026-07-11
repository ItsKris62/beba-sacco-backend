import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { MemberDashboardDto } from '../../common/dto/member-dashboard.dto';

export interface DashboardReports {
  loansByStatus: Array<{ status: string; count: number; totalAmount: number }>;
  savingsByWeek: Array<{ weekNumber: number; totalAmount: number; memberCount: number }>;
  topDefaulters: Array<{ memberNumber: string; outstandingBalance: number; arrearsDays: number }>;
  loanProductMix: Array<{ productId: string; productName: string; count: number; totalDisbursed: number; avgLoanSize: number }>;
  agingBuckets: {
    current: number;
    days1to30: number;
    days31to60: number;
    days61to90: number;
    days90Plus: number;
  };
  generatedAt: string;
}

export type ExecutiveOverviewRange = '30d' | '90d' | '1y';

/**
 * NOTE: no `delinquency` time series here, despite it being requested — this
 * schema has no historical PAR/delinquency snapshot table and nothing crons
 * one into existence (Loan.arrearsDays/staging are current-state only;
 * SasraRatioSnapshot is monthly and only written on-demand, not a reliable
 * daily series). Fabricating a trend from a single current data point would
 * be misleading, so this was intentionally left out rather than invented.
 * Revisit if/when a daily portfolio snapshot job is built.
 */
export interface ExecutiveOverview {
  range: ExecutiveOverviewRange;
  revenue: Array<{ date: string; amount: number }>;
  disbursements: Array<{ date: string; amount: number }>;
  newMembers: Array<{ date: string; count: number }>;
}

export interface GuarantorHealth {
  totalLoansWithGuarantors: number;
  totalActiveLoans: number;
  coveragePercent: number;
  loansWithPartialCoverage: number;
  loansWithFullCoverage: number;
  loansWithNoGuarantors: number;
  guarantorDefaultRate: number;
  averageGuarantorsPerLoan: number;
}

export interface MpesaHeatmap {
  days: number;
  buckets: Array<{ day: string; hour: number; totalAmount: number; transactionCount: number }>;
}

const MEMBER_DASH_CACHE_KEY = (tenantId: string, userId: string) =>
  `DASH:MEMBER:${tenantId}:${userId}:v4`;
const MEMBER_DASH_STALE_KEY = (tenantId: string, userId: string) =>
  `DASH:MEMBER:${tenantId}:${userId}:stale:v4`;

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async getReports(tenantId: string): Promise<DashboardReports> {
    const [loansByStatus, savingsByWeek, topDefaulters, loanProductMix, agingBuckets] = await Promise.all([
      this.getLoansByStatus(tenantId),
      this.getSavingsByWeek(tenantId),
      this.getTopDefaulters(tenantId),
      this.getLoanProductMix(tenantId),
      this.getAgingBuckets(tenantId),
    ]);

    return {
      loansByStatus,
      savingsByWeek,
      topDefaulters,
      loanProductMix,
      agingBuckets,
      generatedAt: new Date().toISOString(),
    };
  }

  async getExecutiveOverview(tenantId: string, range: ExecutiveOverviewRange): Promise<ExecutiveOverview> {
    const cacheKey = `admin:exec-overview:${tenantId}:${range}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as ExecutiveOverview;
      } catch {
        /* fallthrough to fresh query */
      }
    }

    const overview = await this.computeExecutiveOverview(tenantId, range);
    await this.redis.set(cacheKey, JSON.stringify(overview), 300); // 5 min
    return overview;
  }

  async getGuarantorHealth(tenantId: string): Promise<GuarantorHealth> {
    const cacheKey = `admin:guarantor-health:${tenantId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as GuarantorHealth;
      } catch {
        /* fallthrough to fresh query */
      }
    }

    const health = await this.computeGuarantorHealth(tenantId);
    await this.redis.set(cacheKey, JSON.stringify(health), 600); // 10 min
    return health;
  }

  async getMpesaHeatmap(tenantId: string, days: number): Promise<MpesaHeatmap> {
    const cacheKey = `admin:mpesa-heatmap:${tenantId}:${days}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as MpesaHeatmap;
      } catch {
        /* fallthrough to fresh query */
      }
    }

    const heatmap = await this.computeMpesaHeatmap(tenantId, days);
    await this.redis.set(cacheKey, JSON.stringify(heatmap), 120); // 2 min
    return heatmap;
  }

  private async computeExecutiveOverview(
    tenantId: string,
    range: ExecutiveOverviewRange,
  ): Promise<ExecutiveOverview> {
    const daysBack = range === '30d' ? 30 : range === '90d' ? 90 : 365;
    const bucketUnit = range === '1y' ? 'week' : 'day';
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

    // Revenue = actual GL income (interest/fee/penalty income accounts),
    // not cash inflow — deposits and loan disbursements are balance-sheet
    // movements, not revenue. See ledger.service.ts GL_CODES for the seeded
    // REVENUE-type accounts this joins against.
    const revenueRows = await this.prisma.$queryRaw<Array<{ bucket: Date; total: string | null }>>`
      SELECT DATE_TRUNC(${bucketUnit}, gp."postingDate") AS bucket, SUM(gp.amount) AS total
      FROM "GLPosting" gp
      JOIN "JournalEntry" je ON je.id = gp."journalEntryId"
      JOIN "GLAccount" ga ON ga.id = gp."creditAccountId"
      WHERE je."tenantId" = ${tenantId}
        AND je.status = 'POSTED'
        AND ga.type = 'REVENUE'
        AND gp."postingDate" >= ${since}
      GROUP BY 1
      ORDER BY 1
    `;

    const disbursementRows = await this.prisma.$queryRaw<Array<{ bucket: Date; total: string | null }>>`
      SELECT DATE_TRUNC(${bucketUnit}, l."disbursedAt") AS bucket, SUM(l."principalAmount") AS total
      FROM "Loan" l
      WHERE l."tenantId" = ${tenantId}
        AND l."disbursedAt" >= ${since}
      GROUP BY 1
      ORDER BY 1
    `;

    const newMemberRows = await this.prisma.$queryRaw<Array<{ bucket: Date; cnt: bigint }>>`
      SELECT DATE_TRUNC(${bucketUnit}, m."joinedAt") AS bucket, COUNT(*) AS cnt
      FROM "Member" m
      WHERE m."tenantId" = ${tenantId}
        AND m."joinedAt" >= ${since}
      GROUP BY 1
      ORDER BY 1
    `;

    return {
      range,
      revenue: revenueRows.map((r) => ({ date: r.bucket.toISOString(), amount: Number(r.total ?? 0) })),
      disbursements: disbursementRows.map((r) => ({ date: r.bucket.toISOString(), amount: Number(r.total ?? 0) })),
      newMembers: newMemberRows.map((r) => ({ date: r.bucket.toISOString(), count: Number(r.cnt) })),
    };
  }

  private async computeGuarantorHealth(tenantId: string): Promise<GuarantorHealth> {
    const [totalActiveLoans, coverageRows, guarantorRows] = await Promise.all([
      this.prisma.loan.count({ where: { tenantId, status: 'ACTIVE' } }),
      // Per-active-loan guarantee coverage, classified DB-side (never loaded
      // into JS row-by-row) — same perf convention as the PAR30/aging queries.
      this.prisma.$queryRaw<Array<{ full: bigint; partial: bigint; none: bigint; total_guarantors: bigint }>>`
        SELECT
          COUNT(*) FILTER (WHERE sub.covered >= sub."principalAmount") AS full,
          COUNT(*) FILTER (WHERE sub.covered > 0 AND sub.covered < sub."principalAmount") AS partial,
          COUNT(*) FILTER (WHERE sub.covered = 0) AS none,
          COALESCE(SUM(sub.guarantor_count), 0) AS total_guarantors
        FROM (
          SELECT l.id, l."principalAmount",
                 COALESCE(SUM(g."guaranteedAmount"), 0) AS covered,
                 COUNT(g.id) AS guarantor_count
          FROM "Loan" l
          LEFT JOIN "Guarantor" g ON g."loanId" = l.id AND g.status = 'ACCEPTED'
          WHERE l."tenantId" = ${tenantId} AND l.status = 'ACTIVE'
          GROUP BY l.id, l."principalAmount"
        ) sub
      `,
      // Guarantor default rate: of members currently acting as an ACCEPTED
      // guarantor, what % have one of their OWN loans in default/NPL.
      // Note: the LoanGuarantor Prisma model is @@map("Guarantor") — raw SQL
      // must use the mapped table name, not the model name.
      this.prisma.$queryRaw<Array<{ total: bigint; defaulting: bigint }>>`
        SELECT
          COUNT(DISTINCT g."memberId") AS total,
          COUNT(DISTINCT g."memberId") FILTER (
            WHERE EXISTS (
              SELECT 1 FROM "Loan" ol
              WHERE ol."memberId" = g."memberId"
                AND ol."tenantId" = ${tenantId}
                AND (ol.status = 'DEFAULTED' OR ol.staging = 'NPL')
            )
          ) AS defaulting
        FROM "Guarantor" g
        WHERE g."tenantId" = ${tenantId} AND g.status = 'ACCEPTED'
      `,
    ]);

    const { full, partial, none, total_guarantors } = coverageRows[0] ?? {
      full: 0n,
      partial: 0n,
      none: 0n,
      total_guarantors: 0n,
    };
    const { total: totalGuarantorMembers, defaulting } = guarantorRows[0] ?? { total: 0n, defaulting: 0n };

    const fullCount = Number(full);
    const partialCount = Number(partial);
    const noneCount = Number(none);

    return {
      totalLoansWithGuarantors: fullCount + partialCount,
      totalActiveLoans,
      // "Coverage" here means fully-covered active loans — partial/no-guarantor
      // loans still carry real exposure, so they're surfaced separately rather
      // than folded into a softer headline number.
      coveragePercent: totalActiveLoans > 0 ? Math.round((fullCount / totalActiveLoans) * 10000) / 100 : 0,
      loansWithPartialCoverage: partialCount,
      loansWithFullCoverage: fullCount,
      loansWithNoGuarantors: noneCount,
      guarantorDefaultRate:
        Number(totalGuarantorMembers) > 0
          ? Math.round((Number(defaulting) / Number(totalGuarantorMembers)) * 10000) / 100
          : 0,
      averageGuarantorsPerLoan:
        totalActiveLoans > 0 ? Math.round((Number(total_guarantors) / totalActiveLoans) * 100) / 100 : 0,
    };
  }

  private async computeMpesaHeatmap(tenantId: string, days: number): Promise<MpesaHeatmap> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.$queryRaw<
      Array<{ day: Date; hour: number; total: string | null; cnt: bigint }>
    >`
      SELECT
        DATE("createdAt") AS day,
        EXTRACT(HOUR FROM "createdAt")::int AS hour,
        SUM(amount) AS total,
        COUNT(*) AS cnt
      FROM "MpesaTransaction"
      WHERE "tenantId" = ${tenantId}
        AND status = 'COMPLETED'
        AND "createdAt" >= ${since}
      GROUP BY 1, 2
      ORDER BY 1, 2
    `;

    return {
      days,
      buckets: rows.map((r) => ({
        day: r.day.toISOString().slice(0, 10),
        hour: r.hour,
        totalAmount: Number(r.total ?? 0),
        transactionCount: Number(r.cnt),
      })),
    };
  }

  async getMemberDashboard(
    tenantId: string,
    userId: string,
    correlationId?: string,
  ): Promise<{ data: MemberDashboardDto; partial: boolean }> {
    const freshKey = MEMBER_DASH_CACHE_KEY(tenantId, userId);
    const cached = await this.redis.getJson<MemberDashboardDto>(freshKey);
    if (cached) return { data: cached, partial: Boolean(cached.warnings?.length) };

    const staleKey = MEMBER_DASH_STALE_KEY(tenantId, userId);
    const member = await this.prisma.member.findFirst({
      where: { tenantId, userId, isActive: true },
      select: {
        id: true,
        memberNumber: true,
        kycStatus: true,
        kycRejectionReason: true,
        user: { select: { firstName: true, lastName: true, email: true, profileImageKey: true, updatedAt: true } },
      },
    });
    if (!member) throw new NotFoundException('Member profile not found');

    const [accountsResult, loansResult, transactionsResult, guarantorsResult] = await Promise.allSettled([
      this.prisma.account.findMany({
        where: { memberId: member.id, tenantId, isActive: true },
        select: { id: true, accountType: true, balance: true },
      }),
      this.prisma.loan.findMany({
        where: { memberId: member.id, tenantId, status: { in: ['ACTIVE', 'DISBURSED', 'APPROVED'] } },
        select: {
          id: true,
          loanNumber: true,
          principalAmount: true,
          outstandingBalance: true,
          monthlyInstalment: true,
          dueDate: true,
        },
        orderBy: { appliedAt: 'desc' },
        take: 10,
      }),
      this.prisma.transaction.findMany({
        where: { tenantId, account: { memberId: member.id } },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          type: true,
          amount: true,
          balanceAfter: true,
          description: true,
          createdAt: true,
          account: { select: { accountType: true } },
        },
      }),
      this.prisma.loanGuarantor.findMany({
        where: { memberId: member.id, tenantId, status: 'PENDING' },
        select: {
          id: true,
          loanId: true,
          guaranteedAmount: true,
          invitedAt: true,
          loan: {
            select: {
              loanNumber: true,
              principalAmount: true,
              purpose: true,
              member: {
                select: {
                  user: { select: { firstName: true, lastName: true } },
                },
              },
            },
          },
        },
      }),
    ]);

    const warnings: string[] = [];
    if (accountsResult.status === 'rejected') warnings.push('accounts data is temporarily unavailable');
    if (loansResult.status === 'rejected') warnings.push('loans data is temporarily unavailable');
    if (transactionsResult.status === 'rejected') warnings.push('transactions data is temporarily unavailable');
    if (guarantorsResult.status === 'rejected') warnings.push('guarantors data is temporarily unavailable');

    if (warnings.length === 4) {
      const stale = await this.redis.getJson<MemberDashboardDto>(staleKey);
      if (stale) {
        this.logger.warn(
          `Member dashboard serving stale cache tenant=${tenantId} user=${userId} correlation=${correlationId ?? 'none'}`,
        );
        return {
          data: {
            ...stale,
            warnings: [...(stale.warnings ?? []), 'Dashboard data is temporarily stale.'],
          },
          partial: true,
        };
      }
      throw new ServiceUnavailableException('Dashboard data is temporarily unavailable');
    }

    const accounts = accountsResult.status === 'fulfilled' ? accountsResult.value : [];
    const activeLoans = loansResult.status === 'fulfilled' ? loansResult.value : [];
    const recentTransactions =
      transactionsResult.status === 'fulfilled' ? transactionsResult.value : [];
    const pendingGuarantorRequests =
      guarantorsResult.status === 'fulfilled' ? guarantorsResult.value : [];

    const fosa = accounts.find((a) => a.accountType === 'FOSA');
    const bosa = accounts.find((a) => a.accountType === 'BOSA');
    const data: MemberDashboardDto = {
      member: {
        id: member.id,
        memberNumber: member.memberNumber,
        name: `${member.user.firstName} ${member.user.lastName}`,
        email: member.user.email,
        kycStatus: member.kycStatus,
        kycRejectionReason: member.kycRejectionReason,
        profileImageKey: member.user.profileImageKey,
        updatedAt: member.user.updatedAt.toISOString(),
      },
      balances: {
        fosa: Number(fosa?.balance ?? 0),
        bosa: Number(bosa?.balance ?? 0),
        fosaAccountId: fosa?.id ?? null,
        bosaAccountId: bosa?.id ?? null,
      },
      activeLoans: activeLoans.map((loan) => ({
        id: loan.id,
        loanNumber: loan.loanNumber,
        principalAmount: Number(loan.principalAmount),
        outstandingBalance: Number(loan.outstandingBalance),
        monthlyInstalment: Number(loan.monthlyInstalment),
        dueDate: loan.dueDate?.toISOString() ?? null,
      })),
      recentTransactions: recentTransactions.map((tx) => ({
        id: tx.id,
        type: tx.type,
        amount: Number(tx.amount),
        balanceAfter: Number(tx.balanceAfter),
        description: tx.description,
        createdAt: tx.createdAt.toISOString(),
        account: tx.account,
      })),
      pendingGuarantorRequests: pendingGuarantorRequests.map((request) => ({
        guarantorId: request.id,
        loanId: request.loanId,
        loanNumber: request.loan.loanNumber,
        applicantName: `${request.loan.member.user.firstName} ${request.loan.member.user.lastName}`,
        loanAmount: Number(request.loan.principalAmount),
        guaranteedAmount: Number(request.guaranteedAmount),
        purpose: request.loan.purpose,
        invitedAt: request.invitedAt.toISOString(),
      })),
      loadedAt: new Date().toISOString(),
      ...(warnings.length > 0 && { warnings }),
    };

    await Promise.all([
      this.redis.setJson(freshKey, data, 60),
      this.redis.setJson(staleKey, data, 60 * 60),
    ]);
    return { data, partial: warnings.length > 0 };
  }

  private async getLoansByStatus(
    tenantId: string,
  ): Promise<Array<{ status: string; count: number; totalAmount: number }>> {
    const grouped = await this.prisma.loan.groupBy({
      by: ['status'],
      where: { tenantId },
      _count: { id: true },
      _sum: { principalAmount: true },
    });

    return grouped.map((g) => ({
      status: g.status,
      count: g._count.id,
      totalAmount: Number(g._sum.principalAmount ?? 0),
    }));
  }

  private async getSavingsByWeek(
    tenantId: string,
  ): Promise<Array<{ weekNumber: number; totalAmount: number; memberCount: number }>> {
    const grouped = await this.prisma.savingsRecord.groupBy({
      by: ['weekNumber'],
      where: { tenantId },
      _sum: { amount: true },
      _count: { id: true },
      orderBy: { weekNumber: 'asc' },
    });

    return grouped.map((g) => ({
      weekNumber: g.weekNumber,
      totalAmount: Number(g._sum.amount ?? 0),
      memberCount: g._count.id,
    }));
  }

  /**
   * Loan products are per-tenant rows (LoanProduct.name), not a fixed enum —
   * different tenants can name/offer different products — so this groups by
   * whatever products the tenant actually has rather than assuming any
   * specific product names exist.
   */
  private async getLoanProductMix(
    tenantId: string,
  ): Promise<Array<{ productId: string; productName: string; count: number; totalDisbursed: number; avgLoanSize: number }>> {
    const grouped = await this.prisma.loan.groupBy({
      by: ['loanProductId'],
      where: { tenantId, status: 'ACTIVE' },
      _count: { id: true },
      _sum: { principalAmount: true },
      _avg: { principalAmount: true },
    });
    if (grouped.length === 0) return [];

    const products = await this.prisma.loanProduct.findMany({
      where: { tenantId, id: { in: grouped.map((g) => g.loanProductId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(products.map((p) => [p.id, p.name]));

    // Sorted by name (identity), not by totalDisbursed (value) — so a
    // product's position/assigned chart color stays stable across refetches
    // instead of reshuffling whenever the ranking by amount changes.
    return grouped
      .map((g) => ({
        productId: g.loanProductId,
        productName: nameById.get(g.loanProductId) ?? 'Unknown product',
        count: g._count.id,
        totalDisbursed: Number(g._sum.principalAmount ?? 0),
        avgLoanSize: Number(g._avg.principalAmount ?? 0),
      }))
      .sort((a, b) => a.productName.localeCompare(b.productName));
  }

  /**
   * SASRA-style arrears aging on the active loan book. Buckets are DB-side
   * counts (not a JS reduce over loaded rows) for the same reason the admin
   * dashboard stats keep PAR30 as an aggregate query — this needs to stay
   * fast at 100k+ loan rows.
   */
  private async getAgingBuckets(tenantId: string): Promise<DashboardReports['agingBuckets']> {
    const activeWhere = { tenantId, status: 'ACTIVE' as const };
    const [current, days1to30, days31to60, days61to90, days90Plus] = await Promise.all([
      this.prisma.loan.count({ where: { ...activeWhere, arrearsDays: { lte: 0 } } }),
      this.prisma.loan.count({ where: { ...activeWhere, arrearsDays: { gte: 1, lte: 30 } } }),
      this.prisma.loan.count({ where: { ...activeWhere, arrearsDays: { gte: 31, lte: 60 } } }),
      this.prisma.loan.count({ where: { ...activeWhere, arrearsDays: { gte: 61, lte: 90 } } }),
      this.prisma.loan.count({ where: { ...activeWhere, arrearsDays: { gt: 90 } } }),
    ]);

    return { current, days1to30, days31to60, days61to90, days90Plus };
  }

  private async getTopDefaulters(
    tenantId: string,
  ): Promise<Array<{ memberNumber: string; outstandingBalance: number; arrearsDays: number }>> {
    const loans = await this.prisma.loan.findMany({
      where: { tenantId, status: 'DEFAULTED' },
      orderBy: { outstandingBalance: 'desc' },
      take: 10,
      select: {
        outstandingBalance: true,
        arrearsDays: true,
        member: { select: { memberNumber: true } },
      },
    });

    return loans.map((l) => ({
      memberNumber: l.member.memberNumber,
      outstandingBalance: Number(l.outstandingBalance),
      arrearsDays: l.arrearsDays,
    }));
  }
}
