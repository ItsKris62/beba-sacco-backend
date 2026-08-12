import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  AccountStatus,
  GuarantorStatus,
  JournalEntryStatus,
  KycStatus,
  LoanStaging,
  LoanStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { MemberDashboardDto } from '../../common/dto/member-dashboard.dto';
import {
  DashboardDrilldownQueryDto,
  DashboardDrilldownSource,
  DelinquencyTrendsQueryDto,
  GuarantorCorrelationQueryDto,
} from './dto/dashboard-drilldown.dto';

export const MIN_GUARANTEES_FOR_CORRELATION = 5;

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

export interface DelinquencyTrendPoint {
  date: string;
  totalLoans: number;
  delinquentLoans: number;
  watchlistLoans: number;
  nplLoans: number;
  averageArrearsDays: number;
  par30Rate: number;
}

export interface DelinquencyTrends {
  from: string;
  to: string;
  loanProductId?: string;
  points: DelinquencyTrendPoint[];
}

export interface GuarantorCorrelationRow {
  memberId: string;
  memberNumber: string;
  name: string;
  totalGuarantees: number;
  defaultedGuarantees: number;
  defaultCorrelationRate: number;
  totalGuaranteedAmount: number;
  recoveredAmount: number;
  activeGuarantees: number;
  defaultedActiveGuarantees: number;
  closedGuarantees: number;
}

export interface GuarantorCorrelationResponse {
  minGuaranteesForCorrelation: number;
  ranked: GuarantorCorrelationRow[];
  belowThreshold?: GuarantorCorrelationRow[];
  excludedBelowThreshold: number;
  generatedAt: string;
  defaultEvidenceDefinition: string;
}

export interface DashboardDrilldownResponse {
  source: DashboardDrilldownSource;
  data: Array<Record<string, unknown>>;
  meta: { total: number; page: number; limit: number; totalPages: number };
}

const MEMBER_DASH_CACHE_KEY = (tenantId: string, userId: string) =>
  `DASH:MEMBER:${tenantId}:${userId}:v5`;
const MEMBER_DASH_STALE_KEY = (tenantId: string, userId: string) =>
  `DASH:MEMBER:${tenantId}:${userId}:stale:v5`;

function toDateOnly(date: string): Date {
  return new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizeDashboardPhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 9 && digits.startsWith('7')) return `254${digits}`;
  if (digits.length === 10 && digits.startsWith('07')) return `254${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('254')) return digits;
  return phone;
}

function maskDashboardPhone(phone?: string | null): string | null {
  const normalized = normalizeDashboardPhone(phone);
  if (!normalized) return null;
  if (normalized.length < 7) return '********';
  return `+${normalized.slice(0, 3)} ${normalized.slice(3, 4)}** *** ${normalized.slice(-3)}`;
}

function memberWithdrawalReference(createdAt: Date, transactionId: string): string {
  const date = createdAt.toISOString().slice(0, 10).replace(/-/g, '');
  return `WD-${date}-${transactionId.slice(0, 8).toUpperCase()}`;
}

function mapWithdrawalMemberState(params: {
  transactionStatus?: string | null;
  mpesaStatus?: string | null;
  providerSubmissionState?: string | null;
  manualReviewRequired?: boolean | null;
}): { memberStatus: string; memberStatusLabel: string } {
  if (params.mpesaStatus === 'COMPLETED') {
    return { memberStatus: 'COMPLETED', memberStatusLabel: 'Completed' };
  }
  if (params.mpesaStatus === 'FAILED' && params.transactionStatus === 'REVERSED') {
    return { memberStatus: 'FAILED_FUNDS_RESTORED', memberStatusLabel: 'Failed - funds restored' };
  }
  if (
    params.mpesaStatus === 'RECON_PENDING' ||
    params.manualReviewRequired ||
    params.providerSubmissionState === 'PROVIDER_OUTCOME_UNKNOWN' ||
    params.mpesaStatus === 'FAILED'
  ) {
    return {
      memberStatus: 'CONFIRMATION_DELAYED',
      memberStatusLabel: 'Processing - confirmation delayed',
    };
  }
  if (params.providerSubmissionState === 'SEND_IN_PROGRESS') {
    return { memberStatus: 'SENDING_TO_MPESA', memberStatusLabel: 'Sending to M-Pesa' };
  }
  return { memberStatus: 'PROCESSING', memberStatusLabel: 'Processing' };
}

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

  async getDelinquencyTrends(
    tenantId: string,
    query: DelinquencyTrendsQueryDto,
  ): Promise<DelinquencyTrends> {
    const today = new Date();
    const defaultFrom = new Date(today);
    defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 29);

    const from = query.from ? query.from.slice(0, 10) : isoDate(defaultFrom);
    const to = query.to ? query.to.slice(0, 10) : isoDate(today);
    const fromDate = toDateOnly(from);
    const toDate = toDateOnly(to);

    if (fromDate > toDate) {
      throw new BadRequestException('from must be before or equal to to');
    }

    const productFilter = query.loanProductId
      ? Prisma.sql`AND l."loanProductId" = ${query.loanProductId}`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{
        date: Date;
        total_loans: bigint;
        delinquent_loans: bigint;
        watchlist_loans: bigint;
        npl_loans: bigint;
        avg_arrears_days: string | null;
      }>
    >`
      SELECT
        s."snapshotDate"::date AS date,
        COUNT(*) AS total_loans,
        COUNT(*) FILTER (WHERE s."arrearsDays" > 0) AS delinquent_loans,
        COUNT(*) FILTER (WHERE s.staging = 'WATCHLIST') AS watchlist_loans,
        COUNT(*) FILTER (WHERE s.staging = 'NPL') AS npl_loans,
        AVG(s."arrearsDays") AS avg_arrears_days
      FROM "LoanArrearsSnapshot" s
      JOIN "Loan" l
        ON l.id = s."loanId"
       AND l."tenantId" = s."tenantId"
      WHERE s."tenantId" = ${tenantId}
        AND s."snapshotDate" BETWEEN ${fromDate} AND ${toDate}
        ${productFilter}
      GROUP BY s."snapshotDate"
      ORDER BY s."snapshotDate" ASC
    `;

    return {
      from,
      to,
      ...(query.loanProductId && { loanProductId: query.loanProductId }),
      points: rows.map((row) => {
        const totalLoans = Number(row.total_loans);
        const watchlistLoans = Number(row.watchlist_loans);
        const nplLoans = Number(row.npl_loans);
        return {
          date: isoDate(row.date),
          totalLoans,
          delinquentLoans: Number(row.delinquent_loans),
          watchlistLoans,
          nplLoans,
          averageArrearsDays: Math.round(Number(row.avg_arrears_days ?? 0) * 100) / 100,
          par30Rate:
            totalLoans > 0
              ? Math.round(((watchlistLoans + nplLoans) / totalLoans) * 10000) / 100
              : 0,
        };
      }),
    };
  }

  async getGuarantorCorrelation(
    tenantId: string,
    query: GuarantorCorrelationQueryDto = {},
  ): Promise<GuarantorCorrelationResponse> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        memberId: string;
        memberNumber: string;
        firstName: string;
        lastName: string;
        totalGuarantees: bigint;
        defaultedGuarantees: bigint;
        totalGuaranteedAmount: string | null;
        recoveredAmount: string | null;
        activeGuarantees: bigint;
        defaultedActiveGuarantees: bigint;
        closedGuarantees: bigint;
      }>
    >`
      SELECT
        m.id AS "memberId",
        m."memberNumber" AS "memberNumber",
        u."firstName" AS "firstName",
        u."lastName" AS "lastName",
        COUNT(g.id) AS "totalGuarantees",
        COUNT(g.id) FILTER (
          WHERE l.status IN ('DEFAULTED', 'WRITTEN_OFF')
             OR l.staging = 'NPL'
             OR g."recoveredAmount" > 0
             OR g."recoveryDate" IS NOT NULL
        ) AS "defaultedGuarantees",
        COALESCE(SUM(g."guaranteedAmount"), 0)::text AS "totalGuaranteedAmount",
        COALESCE(SUM(g."recoveredAmount"), 0)::text AS "recoveredAmount",
        COUNT(g.id) FILTER (
          WHERE l.status IN (
            'PENDING_GUARANTORS',
            'PENDING_REVIEW',
            'PENDING_APPROVAL',
            'APPROVED',
            'DISBURSED',
            'ACTIVE'
          )
        ) AS "activeGuarantees",
        COUNT(g.id) FILTER (
          WHERE l.status = 'DEFAULTED'
             OR (l.status NOT IN ('FULLY_PAID', 'WRITTEN_OFF') AND l.staging = 'NPL')
        ) AS "defaultedActiveGuarantees",
        COUNT(g.id) FILTER (
          WHERE l.status IN ('FULLY_PAID', 'WRITTEN_OFF')
        ) AS "closedGuarantees"
      FROM "Guarantor" g
      JOIN "Loan" l ON l.id = g."loanId" AND l."tenantId" = ${tenantId}
      JOIN "Member" m ON m.id = g."memberId" AND m."tenantId" = ${tenantId}
      JOIN "User" u ON u.id = m."userId" AND u."tenantId" = ${tenantId}
      WHERE g."tenantId" = ${tenantId}
        AND g.status = 'ACCEPTED'
      GROUP BY m.id, m."memberNumber", u."firstName", u."lastName"
    `;

    const mapped = rows
      .map((row) => {
        const totalGuarantees = Number(row.totalGuarantees);
        const defaultedGuarantees = Number(row.defaultedGuarantees);
        return {
          memberId: row.memberId,
          memberNumber: row.memberNumber,
          name: `${row.firstName} ${row.lastName}`,
          totalGuarantees,
          defaultedGuarantees,
          defaultCorrelationRate:
            totalGuarantees > 0 ? Math.round((defaultedGuarantees / totalGuarantees) * 10000) / 100 : 0,
          totalGuaranteedAmount: Number(row.totalGuaranteedAmount ?? 0),
          recoveredAmount: Number(row.recoveredAmount ?? 0),
          activeGuarantees: Number(row.activeGuarantees),
          defaultedActiveGuarantees: Number(row.defaultedActiveGuarantees),
          closedGuarantees: Number(row.closedGuarantees),
        };
      })
      .sort((a, b) => b.defaultCorrelationRate - a.defaultCorrelationRate || b.totalGuarantees - a.totalGuarantees);

    const ranked = mapped.filter((row) => row.totalGuarantees >= MIN_GUARANTEES_FOR_CORRELATION);
    const belowThreshold = mapped.filter((row) => row.totalGuarantees < MIN_GUARANTEES_FOR_CORRELATION);
    const includeBelowThreshold = query.includeBelowThreshold === 'true';

    return {
      minGuaranteesForCorrelation: MIN_GUARANTEES_FOR_CORRELATION,
      ranked,
      ...(includeBelowThreshold && { belowThreshold }),
      excludedBelowThreshold: belowThreshold.length,
      generatedAt: new Date().toISOString(),
      defaultEvidenceDefinition:
        'status IN (DEFAULTED, WRITTEN_OFF) OR staging = NPL OR recoveredAmount > 0 OR recoveryDate IS NOT NULL',
    };
  }

  async getDrilldown(tenantId: string, query: DashboardDrilldownQueryDto): Promise<DashboardDrilldownResponse> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    switch (query.source) {
      case DashboardDrilldownSource.TRANSACTION:
        return this.getTransactionDrilldown(tenantId, query, page, limit, skip);
      case DashboardDrilldownSource.MPESA:
        return this.getMpesaDrilldown(tenantId, query, page, limit, skip);
      case DashboardDrilldownSource.LOAN:
        return this.getLoanDrilldown(tenantId, query, page, limit, skip);
      case DashboardDrilldownSource.GUARANTOR:
        return this.getGuarantorDrilldown(tenantId, query, page, limit, skip);
      case DashboardDrilldownSource.MEMBER:
        return this.getMemberDrilldown(tenantId, query, page, limit, skip);
      case DashboardDrilldownSource.JOURNAL:
        return this.getJournalDrilldown(tenantId, query, page, limit, skip);
      default:
        throw new BadRequestException('Unsupported dashboard drill-down source');
    }
  }

  private buildCreatedAtFilter(query: Pick<DashboardDrilldownQueryDto, 'from' | 'to'>) {
    if (!query.from && !query.to) return undefined;
    return {
      ...(query.from && { gte: new Date(query.from) }),
      ...(query.to && { lte: new Date(query.to) }),
    };
  }

  private buildLoanDateFilter(query: DashboardDrilldownQueryDto): Prisma.LoanWhereInput {
    const dateFilter = this.buildCreatedAtFilter(query);
    if (!dateFilter) return {};
    switch (query.loanDateField) {
      case 'appliedAt':
        return { appliedAt: dateFilter };
      case 'disbursedAt':
        return { disbursedAt: dateFilter };
      default:
        return { createdAt: dateFilter };
    }
  }

  private meta(total: number, page: number, limit: number) {
    return { total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  private async getTransactionDrilldown(
    tenantId: string,
    query: DashboardDrilldownQueryDto,
    page: number,
    limit: number,
    skip: number,
  ): Promise<DashboardDrilldownResponse> {
    const createdAt = this.buildCreatedAtFilter(query);
    const loanWhere: Prisma.LoanWhereInput = {
      ...(query.loanStatus && { status: query.loanStatus }),
      ...(query.loanStaging && { staging: query.loanStaging }),
      ...(query.loanProductId && { loanProductId: query.loanProductId }),
    };
    const where: Prisma.TransactionWhereInput = {
      tenantId,
      ...(query.type && { type: query.type }),
      ...(query.status && { status: query.status }),
      ...(createdAt && { createdAt }),
      ...(query.accountType && { account: { accountType: query.accountType } }),
      ...(Object.keys(loanWhere).length > 0 && { loan: loanWhere }),
      ...(query.search && {
        OR: [
          { reference: { contains: query.search, mode: 'insensitive' } },
          { account: { accountNumber: { contains: query.search, mode: 'insensitive' } } },
        ],
      }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          account: {
            select: {
              accountNumber: true,
              accountType: true,
              member: {
                select: {
                  memberNumber: true,
                  user: { select: { firstName: true, lastName: true } },
                },
              },
            },
          },
          loan: { select: { loanNumber: true, status: true, staging: true } },
        },
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return {
      source: DashboardDrilldownSource.TRANSACTION,
      data: rows.map((row) => ({
        id: row.id,
        reference: row.reference,
        type: row.type,
        status: row.status,
        amount: Number(row.amount),
        balanceAfter: Number(row.balanceAfter),
        description: row.description,
        createdAt: row.createdAt,
        accountNumber: row.account.accountNumber,
        accountType: row.account.accountType,
        memberNumber: row.account.member.memberNumber,
        memberName: `${row.account.member.user.firstName} ${row.account.member.user.lastName}`,
        loanNumber: row.loan?.loanNumber ?? null,
      })),
      meta: this.meta(total, page, limit),
    };
  }

  private async getMpesaDrilldown(
    tenantId: string,
    query: DashboardDrilldownQueryDto,
    page: number,
    limit: number,
    skip: number,
  ): Promise<DashboardDrilldownResponse> {
    const createdAt = this.buildCreatedAtFilter(query);
    const where: Prisma.MpesaTransactionWhereInput = {
      tenantId,
      ...(query.status && { status: query.status }),
      ...(query.mpesaType && { type: query.mpesaType }),
      ...(createdAt && { createdAt }),
      ...(query.search && {
        OR: [
          { reference: { contains: query.search, mode: 'insensitive' } },
          { mpesaReceiptNumber: { contains: query.search, mode: 'insensitive' } },
          { phoneNumber: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.mpesaTransaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          member: {
            select: {
              memberNumber: true,
              user: { select: { firstName: true, lastName: true } },
            },
          },
          transaction: { select: { reference: true, type: true } },
        },
      }),
      this.prisma.mpesaTransaction.count({ where }),
    ]);

    return {
      source: DashboardDrilldownSource.MPESA,
      data: rows.map((row) => ({
        id: row.id,
        reference: row.reference,
        type: row.type,
        status: row.status,
        amount: Number(row.amount),
        phoneNumber: row.phoneNumber,
        mpesaReceiptNumber: row.mpesaReceiptNumber,
        description: row.description,
        createdAt: row.createdAt,
        transactionDate: row.transactionDate,
        memberNumber: row.member?.memberNumber ?? null,
        memberName: row.member ? `${row.member.user.firstName} ${row.member.user.lastName}` : null,
        ledgerReference: row.transaction?.reference ?? null,
      })),
      meta: this.meta(total, page, limit),
    };
  }

  private loanAgingWhere(query: DashboardDrilldownQueryDto): Prisma.LoanWhereInput {
    switch (query.agingBucket) {
      case 'current':
        return { status: LoanStatus.ACTIVE, arrearsDays: { lte: 0 } };
      case 'arrears':
        return { status: LoanStatus.ACTIVE, arrearsDays: { gt: 0 } };
      case 'days1to30':
        return { status: LoanStatus.ACTIVE, arrearsDays: { gte: 1, lte: 30 } };
      case 'days31to60':
        return { status: LoanStatus.ACTIVE, arrearsDays: { gte: 31, lte: 60 } };
      case 'days61to90':
        return { status: LoanStatus.ACTIVE, arrearsDays: { gte: 61, lte: 90 } };
      case 'days90Plus':
        return { status: LoanStatus.ACTIVE, arrearsDays: { gt: 90 } };
      case 'par30':
        return { status: LoanStatus.ACTIVE, staging: { in: [LoanStaging.WATCHLIST, LoanStaging.NPL] } };
      default:
        return {};
    }
  }

  private snapshotAgingWhere(query: DashboardDrilldownQueryDto): Prisma.LoanArrearsSnapshotWhereInput {
    switch (query.agingBucket) {
      case 'current':
        return { arrearsDays: { lte: 0 } };
      case 'arrears':
        return { arrearsDays: { gt: 0 } };
      case 'days1to30':
        return { arrearsDays: { gte: 1, lte: 30 } };
      case 'days31to60':
        return { arrearsDays: { gte: 31, lte: 60 } };
      case 'days61to90':
        return { arrearsDays: { gte: 61, lte: 90 } };
      case 'days90Plus':
        return { arrearsDays: { gt: 90 } };
      case 'par30':
        return { staging: { in: [LoanStaging.WATCHLIST, LoanStaging.NPL] } };
      default:
        return {};
    }
  }

  private async getCoverageLoanIds(
    tenantId: string,
    coverage: string,
    page: number,
    limit: number,
    skip: number,
  ): Promise<{ ids: string[]; total: number }> {
    if (!['full', 'partial', 'none'].includes(coverage)) {
      return { ids: [], total: 0 };
    }

    const having =
      coverage === 'full'
        ? Prisma.sql`COALESCE(SUM(g."guaranteedAmount"), 0) >= l."principalAmount"`
        : coverage === 'partial'
          ? Prisma.sql`COALESCE(SUM(g."guaranteedAmount"), 0) > 0 AND COALESCE(SUM(g."guaranteedAmount"), 0) < l."principalAmount"`
          : Prisma.sql`COALESCE(SUM(g."guaranteedAmount"), 0) = 0`;

    const totalRows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM (
        SELECT l.id
        FROM "Loan" l
        LEFT JOIN "Guarantor" g ON g."loanId" = l.id AND g."tenantId" = ${tenantId} AND g.status = 'ACCEPTED'
        WHERE l."tenantId" = ${tenantId} AND l.status = 'ACTIVE'
        GROUP BY l.id, l."principalAmount"
        HAVING ${having}
      ) sub
    `;
    const idRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT l.id
      FROM "Loan" l
      LEFT JOIN "Guarantor" g ON g."loanId" = l.id AND g."tenantId" = ${tenantId} AND g.status = 'ACCEPTED'
      WHERE l."tenantId" = ${tenantId} AND l.status = 'ACTIVE'
      GROUP BY l.id, l."principalAmount"
      HAVING ${having}
      ORDER BY l."updatedAt" DESC
      LIMIT ${limit} OFFSET ${skip}
    `;

    return { ids: idRows.map((row) => row.id), total: Number(totalRows[0]?.count ?? 0) };
  }

  private async getCoverageGuarantorIds(
    tenantId: string,
    coverage: string,
    limit: number,
    skip: number,
  ): Promise<{ ids: string[]; total: number }> {
    if (!['full', 'partial'].includes(coverage)) {
      return { ids: [], total: 0 };
    }

    const having =
      coverage === 'full'
        ? Prisma.sql`COALESCE(SUM(g2."guaranteedAmount"), 0) >= l."principalAmount"`
        : Prisma.sql`COALESCE(SUM(g2."guaranteedAmount"), 0) > 0 AND COALESCE(SUM(g2."guaranteedAmount"), 0) < l."principalAmount"`;

    const totalRows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      WITH coverage_loans AS (
        SELECT l.id
        FROM "Loan" l
        LEFT JOIN "Guarantor" g2 ON g2."loanId" = l.id AND g2."tenantId" = ${tenantId} AND g2.status = 'ACCEPTED'
        WHERE l."tenantId" = ${tenantId} AND l.status = 'ACTIVE'
        GROUP BY l.id, l."principalAmount"
        HAVING ${having}
      )
      SELECT COUNT(g.id) AS count
      FROM "Guarantor" g
      JOIN coverage_loans cl ON cl.id = g."loanId"
      WHERE g."tenantId" = ${tenantId}
        AND g.status = 'ACCEPTED'
    `;
    const idRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH coverage_loans AS (
        SELECT l.id
        FROM "Loan" l
        LEFT JOIN "Guarantor" g2 ON g2."loanId" = l.id AND g2."tenantId" = ${tenantId} AND g2.status = 'ACCEPTED'
        WHERE l."tenantId" = ${tenantId} AND l.status = 'ACTIVE'
        GROUP BY l.id, l."principalAmount"
        HAVING ${having}
      )
      SELECT g.id
      FROM "Guarantor" g
      JOIN coverage_loans cl ON cl.id = g."loanId"
      WHERE g."tenantId" = ${tenantId}
        AND g.status = 'ACCEPTED'
      ORDER BY g."createdAt" DESC
      LIMIT ${limit} OFFSET ${skip}
    `;

    return { ids: idRows.map((row) => row.id), total: Number(totalRows[0]?.count ?? 0) };
  }

  private async getLoanDrilldown(
    tenantId: string,
    query: DashboardDrilldownQueryDto,
    page: number,
    limit: number,
    skip: number,
  ): Promise<DashboardDrilldownResponse> {
    if (query.snapshotDate) {
      return this.getLoanSnapshotDrilldown(tenantId, query, page, limit, skip);
    }

    if (query.coverage) {
      const { ids, total } = await this.getCoverageLoanIds(tenantId, query.coverage, page, limit, skip);
      const rows = ids.length
        ? await this.prisma.loan.findMany({
            where: { tenantId, id: { in: ids } },
            include: {
              member: { select: { memberNumber: true, user: { select: { firstName: true, lastName: true } } } },
              loanProduct: { select: { name: true } },
              guarantors: { where: { status: GuarantorStatus.ACCEPTED }, select: { id: true } },
            },
            orderBy: { updatedAt: 'desc' },
          })
        : [];
      return {
        source: DashboardDrilldownSource.LOAN,
        data: rows.map((row) => this.mapLoanDrilldownRow(row)),
        meta: this.meta(total, page, limit),
      };
    }

    const where: Prisma.LoanWhereInput = {
      tenantId,
      ...(query.loanStatus && { status: query.loanStatus }),
      ...(query.loanStaging && { staging: query.loanStaging }),
      ...(query.loanProductId && { loanProductId: query.loanProductId }),
      ...this.buildLoanDateFilter(query),
      ...this.loanAgingWhere(query),
      ...(query.search && {
        OR: [
          { loanNumber: { contains: query.search, mode: 'insensitive' } },
          { member: { memberNumber: { contains: query.search, mode: 'insensitive' } } },
        ],
      }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.loan.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          member: { select: { memberNumber: true, user: { select: { firstName: true, lastName: true } } } },
          loanProduct: { select: { name: true } },
          guarantors: { where: { status: GuarantorStatus.ACCEPTED }, select: { id: true } },
        },
      }),
      this.prisma.loan.count({ where }),
    ]);

    return {
      source: DashboardDrilldownSource.LOAN,
      data: rows.map((row) => this.mapLoanDrilldownRow(row)),
      meta: this.meta(total, page, limit),
    };
  }

  private async getLoanSnapshotDrilldown(
    tenantId: string,
    query: DashboardDrilldownQueryDto,
    page: number,
    limit: number,
    skip: number,
  ): Promise<DashboardDrilldownResponse> {
    const snapshotDate = toDateOnly(query.snapshotDate!);
    const where: Prisma.LoanArrearsSnapshotWhereInput = {
      tenantId,
      snapshotDate,
      ...(query.loanStaging && { staging: query.loanStaging }),
      ...this.snapshotAgingWhere(query),
      loan: {
        ...(query.loanProductId && { loanProductId: query.loanProductId }),
        ...(query.loanStatus && { status: query.loanStatus }),
        ...(query.search && {
          OR: [
            { loanNumber: { contains: query.search, mode: 'insensitive' } },
            { member: { memberNumber: { contains: query.search, mode: 'insensitive' } } },
          ],
        }),
      },
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.loanArrearsSnapshot.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ arrearsDays: 'desc' }, { capturedAt: 'desc' }],
        include: {
          loan: {
            include: {
              member: { select: { memberNumber: true, user: { select: { firstName: true, lastName: true } } } },
              loanProduct: { select: { name: true } },
              guarantors: { where: { status: GuarantorStatus.ACCEPTED }, select: { id: true } },
            },
          },
        },
      }),
      this.prisma.loanArrearsSnapshot.count({ where }),
    ]);

    return {
      source: DashboardDrilldownSource.LOAN,
      data: rows.map((row) => this.mapLoanSnapshotDrilldownRow(row)),
      meta: this.meta(total, page, limit),
    };
  }

  private mapLoanSnapshotDrilldownRow(row: {
    id: string;
    snapshotDate: Date;
    staging: string;
    arrearsDays: number;
    capturedAt: Date;
    loan: {
      id: string;
      loanNumber: string;
      status: LoanStatus;
      principalAmount: Prisma.Decimal;
      outstandingBalance: Prisma.Decimal;
      appliedAt: Date;
      disbursedAt: Date | null;
      member: { memberNumber: string; user: { firstName: string; lastName: string } };
      loanProduct: { name: string };
      guarantors: Array<{ id: string }>;
    };
  }): Record<string, unknown> {
    return {
      id: row.loan.id,
      snapshotId: row.id,
      snapshotDate: isoDate(row.snapshotDate),
      capturedAt: row.capturedAt,
      loanNumber: row.loan.loanNumber,
      status: row.loan.status,
      staging: row.staging,
      principalAmount: Number(row.loan.principalAmount),
      outstandingBalance: Number(row.loan.outstandingBalance),
      arrearsDays: row.arrearsDays,
      appliedAt: row.loan.appliedAt,
      disbursedAt: row.loan.disbursedAt,
      memberNumber: row.loan.member.memberNumber,
      memberName: `${row.loan.member.user.firstName} ${row.loan.member.user.lastName}`,
      loanProductName: row.loan.loanProduct.name,
      acceptedGuarantors: row.loan.guarantors.length,
    };
  }

  private mapLoanDrilldownRow(row: {
    id: string;
    loanNumber: string;
    status: LoanStatus;
    staging: string;
    principalAmount: Prisma.Decimal;
    outstandingBalance: Prisma.Decimal;
    arrearsDays: number;
    appliedAt: Date;
    disbursedAt: Date | null;
    member: { memberNumber: string; user: { firstName: string; lastName: string } };
    loanProduct: { name: string };
    guarantors: Array<{ id: string }>;
  }): Record<string, unknown> {
    return {
      id: row.id,
      loanNumber: row.loanNumber,
      status: row.status,
      staging: row.staging,
      principalAmount: Number(row.principalAmount),
      outstandingBalance: Number(row.outstandingBalance),
      arrearsDays: row.arrearsDays,
      appliedAt: row.appliedAt,
      disbursedAt: row.disbursedAt,
      memberNumber: row.member.memberNumber,
      memberName: `${row.member.user.firstName} ${row.member.user.lastName}`,
      loanProductName: row.loanProduct.name,
      acceptedGuarantors: row.guarantors.length,
    };
  }

  private async getGuarantorDrilldown(
    tenantId: string,
    query: DashboardDrilldownQueryDto,
    page: number,
    limit: number,
    skip: number,
  ): Promise<DashboardDrilldownResponse> {
    const createdAt = this.buildCreatedAtFilter(query);
    const include = {
      member: { select: { memberNumber: true, user: { select: { firstName: true, lastName: true } } } },
      loan: {
        select: {
          loanNumber: true,
          status: true,
          staging: true,
          member: { select: { memberNumber: true, user: { select: { firstName: true, lastName: true } } } },
        },
      },
    } satisfies Prisma.LoanGuarantorInclude;

    if (query.coverage) {
      const { ids, total } = await this.getCoverageGuarantorIds(tenantId, query.coverage, limit, skip);
      const rows = ids.length
        ? await this.prisma.loanGuarantor.findMany({
            where: { tenantId, id: { in: ids } },
            orderBy: { createdAt: 'desc' },
            include,
          })
        : [];
      return {
        source: DashboardDrilldownSource.GUARANTOR,
        data: rows.map((row) => ({
          id: row.id,
          status: row.status,
          guaranteedAmount: Number(row.guaranteedAmount),
          recoveredAmount: Number(row.recoveredAmount),
          invitedAt: row.invitedAt,
          respondedAt: row.respondedAt,
          recoveryDate: row.recoveryDate,
          guarantorMemberNumber: row.member.memberNumber,
          guarantorName: `${row.member.user.firstName} ${row.member.user.lastName}`,
          loanNumber: row.loan.loanNumber,
          loanStatus: row.loan.status,
          loanStaging: row.loan.staging,
          borrowerMemberNumber: row.loan.member.memberNumber,
          borrowerName: `${row.loan.member.user.firstName} ${row.loan.member.user.lastName}`,
        })),
        meta: this.meta(total, page, limit),
      };
    }

    const loanWhere: Prisma.LoanWhereInput = {
      ...(query.loanStatus && { status: query.loanStatus }),
      ...(query.loanStaging && { staging: query.loanStaging }),
      ...(query.loanProductId && { loanProductId: query.loanProductId }),
    };
    const where: Prisma.LoanGuarantorWhereInput = {
      tenantId,
      ...(query.guarantorStatus && { status: query.guarantorStatus }),
      ...(createdAt && { createdAt }),
      ...(Object.keys(loanWhere).length > 0 && { loan: loanWhere }),
      ...(query.search && {
        OR: [
          { member: { memberNumber: { contains: query.search, mode: 'insensitive' } } },
          { loan: { loanNumber: { contains: query.search, mode: 'insensitive' } } },
        ],
      }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.loanGuarantor.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include,
      }),
      this.prisma.loanGuarantor.count({ where }),
    ]);

    return {
      source: DashboardDrilldownSource.GUARANTOR,
      data: rows.map((row) => ({
        id: row.id,
        status: row.status,
        guaranteedAmount: Number(row.guaranteedAmount),
        recoveredAmount: Number(row.recoveredAmount),
        invitedAt: row.invitedAt,
        respondedAt: row.respondedAt,
        recoveryDate: row.recoveryDate,
        guarantorMemberNumber: row.member.memberNumber,
        guarantorName: `${row.member.user.firstName} ${row.member.user.lastName}`,
        loanNumber: row.loan.loanNumber,
        loanStatus: row.loan.status,
        loanStaging: row.loan.staging,
        borrowerMemberNumber: row.loan.member.memberNumber,
        borrowerName: `${row.loan.member.user.firstName} ${row.loan.member.user.lastName}`,
      })),
      meta: this.meta(total, page, limit),
    };
  }

  private async getMemberDrilldown(
    tenantId: string,
    query: DashboardDrilldownQueryDto,
    page: number,
    limit: number,
    skip: number,
  ): Promise<DashboardDrilldownResponse> {
    const createdAt = this.buildCreatedAtFilter(query);
    const segmentWhere: Prisma.MemberWhereInput =
      query.membershipSegment === 'active'
        ? { user: { accountStatus: AccountStatus.ACTIVE } }
        : query.membershipSegment === 'pending'
          ? { kycStatus: KycStatus.PENDING_REVIEW }
          : query.membershipSegment === 'other'
            ? { NOT: [{ user: { accountStatus: AccountStatus.ACTIVE } }, { kycStatus: KycStatus.PENDING_REVIEW }] }
            : {};
    const where: Prisma.MemberWhereInput = {
      tenantId,
      ...(createdAt && { joinedAt: createdAt }),
      ...segmentWhere,
      ...(query.search && {
        OR: [
          { memberNumber: { contains: query.search, mode: 'insensitive' } },
          { user: { firstName: { contains: query.search, mode: 'insensitive' } } },
          { user: { lastName: { contains: query.search, mode: 'insensitive' } } },
          { user: { email: { contains: query.search, mode: 'insensitive' } } },
        ],
      }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.member.findMany({
        where,
        skip,
        take: limit,
        orderBy: { joinedAt: 'desc' },
        include: {
          user: { select: { firstName: true, lastName: true, email: true, accountStatus: true } },
          accounts: { select: { accountType: true, balance: true, isActive: true } },
        },
      }),
      this.prisma.member.count({ where }),
    ]);

    return {
      source: DashboardDrilldownSource.MEMBER,
      data: rows.map((row) => ({
        id: row.id,
        memberNumber: row.memberNumber,
        name: `${row.user.firstName} ${row.user.lastName}`,
        email: row.user.email,
        accountStatus: row.user.accountStatus,
        kycStatus: row.kycStatus,
        isActive: row.isActive,
        joinedAt: row.joinedAt,
        accounts: row.accounts.map((account) => ({
          accountType: account.accountType,
          balance: Number(account.balance),
          isActive: account.isActive,
        })),
      })),
      meta: this.meta(total, page, limit),
    };
  }

  private async getJournalDrilldown(
    tenantId: string,
    query: DashboardDrilldownQueryDto,
    page: number,
    limit: number,
    skip: number,
  ): Promise<DashboardDrilldownResponse> {
    const createdAt = this.buildCreatedAtFilter(query);
    const where: Prisma.JournalEntryWhereInput = {
      tenantId,
      ...(query.journalType && { type: query.journalType }),
      status: query.journalStatus ?? JournalEntryStatus.POSTED,
      ...(createdAt && { createdAt }),
      ...(query.creditAccountType && {
        postings: { some: { creditAccount: { type: query.creditAccountType } } },
      }),
      ...(query.search && {
        OR: [
          { entryNumber: { contains: query.search, mode: 'insensitive' } },
          { description: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.journalEntry.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          createdBy: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.journalEntry.count({ where }),
    ]);

    return {
      source: DashboardDrilldownSource.JOURNAL,
      data: rows.map((row) => ({
        id: row.id,
        entryNumber: row.entryNumber,
        type: row.type,
        status: row.status,
        description: row.description,
        totalAmount: Number(row.totalAmount),
        postedAt: row.postedAt,
        createdAt: row.createdAt,
        createdBy: `${row.createdBy.firstName} ${row.createdBy.lastName}`,
      })),
      meta: this.meta(total, page, limit),
    };
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
        user: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            phoneNumber: true,
            phoneVerified: true,
            profileImageKey: true,
            updatedAt: true,
          },
        },
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
          status: true,
          reference: true,
          mpesaTransaction: {
            select: {
              phoneNumber: true,
              status: true,
              providerSubmissionState: true,
              manualReviewRequired: true,
            },
          },
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
    const phoneCandidates = [member.user.phone, member.user.phoneNumber]
      .map((phone) => normalizeDashboardPhone(phone))
      .filter((phone): phone is string => Boolean(phone));
    const uniquePhones = Array.from(new Set(phoneCandidates));
    const withdrawalDestination =
      uniquePhones.length === 0
        ? { maskedPhone: null, verified: false, status: 'MISSING' as const }
        : uniquePhones.length > 1
          ? {
              maskedPhone: maskDashboardPhone(uniquePhones[0]),
              verified: false,
              status: 'NEEDS_REVIEW' as const,
            }
          : {
              maskedPhone: maskDashboardPhone(uniquePhones[0]),
              verified: member.user.phoneVerified,
              status: member.user.phoneVerified ? ('VERIFIED' as const) : ('UNVERIFIED' as const),
            };
    const data: MemberDashboardDto = {
      member: {
        id: member.id,
        memberNumber: member.memberNumber,
        name: `${member.user.firstName} ${member.user.lastName}`,
        email: member.user.email,
        phone: normalizeDashboardPhone(member.user.phone ?? member.user.phoneNumber),
        phoneVerified: member.user.phoneVerified,
        withdrawalDestination,
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
        status: tx.status,
        reference: tx.reference,
        ...(tx.type === 'WITHDRAWAL' && tx.reference.startsWith('MPESA_WD-')
          ? {
              memberReference: memberWithdrawalReference(tx.createdAt, tx.id),
              ...mapWithdrawalMemberState({
                transactionStatus: tx.status,
                mpesaStatus: tx.mpesaTransaction?.status,
                providerSubmissionState: tx.mpesaTransaction?.providerSubmissionState,
                manualReviewRequired: tx.mpesaTransaction?.manualReviewRequired,
              }),
              maskedDestination:
                maskDashboardPhone(tx.mpesaTransaction?.phoneNumber) ??
                maskDashboardPhone(tx.description),
            }
          : {}),
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
