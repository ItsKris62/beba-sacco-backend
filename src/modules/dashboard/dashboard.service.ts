import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { MemberDashboardDto } from '../../common/dto/member-dashboard.dto';

export interface DashboardStats {
  totalMembers: number;
  activeMembers: number;
  totalLoansCount: number;
  activeLoansCount: number;
  totalDisbursed: number;
  totalRepaid: number;
  outstandingBalance: number;
  defaultedLoans: number;
  defaultRate: number;
  collectionRate: number;
  totalSavings: number;
  welfareCollected: number;
  welfareDeficit: number;
  recentDisbursements: RecentDisbursement[];
  repaymentHeatmap: RepaymentHeatmapEntry[];
  stageWelfareTable: StageWelfareEntry[];
  generatedAt: string;
  cachedUntil: string;
}

export interface RecentDisbursement {
  loanId: string;
  memberNumber: string;
  principal: number;
  disbursedAt: string;
  status: string;
}

export interface RepaymentHeatmapEntry {
  dayNumber: number;
  totalPaid: number;
  count: number;
}

export interface StageWelfareEntry {
  stageName: string;
  weekNumber: number;
  amountCollected: number;
  weeklyTarget: number;
  deficit: number;
}

export interface DashboardReports {
  loansByStatus: Array<{ status: string; count: number; totalAmount: number }>;
  savingsByWeek: Array<{ weekNumber: number; totalAmount: number; memberCount: number }>;
  topDefaulters: Array<{ memberNumber: string; outstandingBalance: number; arrearsDays: number }>;
  generatedAt: string;
}

const CACHE_TTL_SECONDS = 15 * 60;
const CACHE_KEY = (tenantId: string) => `DASH:STATS:${tenantId}:v1`;
const MEMBER_DASH_CACHE_KEY = (tenantId: string, userId: string) =>
  `DASH:MEMBER:${tenantId}:${userId}:v2`;
const MEMBER_DASH_STALE_KEY = (tenantId: string, userId: string) =>
  `DASH:MEMBER:${tenantId}:${userId}:stale:v2`;

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async getStats(tenantId: string): Promise<DashboardStats> {
    const cacheKey = CACHE_KEY(tenantId);
    const cached = await this.redis.getJson<DashboardStats>(cacheKey);
    if (cached) {
      this.logger.debug(`Dashboard stats cache HIT for tenant ${tenantId}`);
      return cached;
    }

    this.logger.debug(`Dashboard stats cache MISS for tenant ${tenantId} – computing…`);
    const stats = await this.computeStats(tenantId);
    await this.redis.setJson(cacheKey, stats, CACHE_TTL_SECONDS);
    return stats;
  }

  async invalidateCache(tenantId: string): Promise<void> {
    await this.redis.del(CACHE_KEY(tenantId));
    this.logger.debug(`Dashboard cache invalidated for tenant ${tenantId}`);
  }

  async getReports(tenantId: string): Promise<DashboardReports> {
    const [loansByStatus, savingsByWeek, topDefaulters] = await Promise.all([
      this.getLoansByStatus(tenantId),
      this.getSavingsByWeek(tenantId),
      this.getTopDefaulters(tenantId),
    ]);

    return {
      loansByStatus,
      savingsByWeek,
      topDefaulters,
      generatedAt: new Date().toISOString(),
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
        user: { select: { firstName: true, lastName: true, email: true } },
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

  private async computeStats(tenantId: string): Promise<DashboardStats> {
    const now = new Date();
    const cachedUntil = new Date(now.getTime() + CACHE_TTL_SECONDS * 1000);

    const [
      memberStats,
      loanAggregates,
      defaultedCount,
      totalLoansCount,
      activeLoansCount,
      savingsTotal,
      welfareStats,
      recentDisbursements,
      repaymentHeatmap,
      stageWelfareTable,
    ] = await Promise.all([
      this.getMemberStats(tenantId),
      this.getLoanAggregates(tenantId),
      this.prisma.loan.count({ where: { tenantId, status: 'DEFAULTED' } }),
      this.prisma.loan.count({ where: { tenantId } }),
      this.prisma.loan.count({ where: { tenantId, status: { in: ['DISBURSED', 'ACTIVE'] } } }),
      this.getSavingsTotal(tenantId),
      this.getWelfareStats(tenantId),
      this.getRecentDisbursements(tenantId),
      this.getRepaymentHeatmap(tenantId),
      this.getStageWelfareTable(tenantId),
    ]);

    const totalDisbursed = Number(loanAggregates._sum.principalAmount ?? 0);
    const totalRepaid = Number(loanAggregates._sum.totalRepaid ?? 0);
    const outstandingBalance = Number(loanAggregates._sum.outstandingBalance ?? 0);
    const defaultRate = totalLoansCount > 0 ? (defaultedCount / totalLoansCount) * 100 : 0;
    const collectionRate = totalDisbursed > 0 ? (totalRepaid / totalDisbursed) * 100 : 0;

    return {
      totalMembers: memberStats.total,
      activeMembers: memberStats.active,
      totalLoansCount,
      activeLoansCount,
      totalDisbursed,
      totalRepaid,
      outstandingBalance,
      defaultedLoans: defaultedCount,
      defaultRate: Math.round(defaultRate * 100) / 100,
      collectionRate: Math.round(collectionRate * 100) / 100,
      totalSavings: savingsTotal,
      welfareCollected: welfareStats.collected,
      welfareDeficit: welfareStats.deficit,
      recentDisbursements,
      repaymentHeatmap,
      stageWelfareTable,
      generatedAt: now.toISOString(),
      cachedUntil: cachedUntil.toISOString(),
    };
  }

  private async getMemberStats(tenantId: string): Promise<{ total: number; active: number }> {
    const [total, active] = await Promise.all([
      this.prisma.member.count({ where: { tenantId } }),
      this.prisma.member.count({ where: { tenantId, isActive: true } }),
    ]);
    return { total, active };
  }

  private async getLoanAggregates(tenantId: string) {
    return this.prisma.loan.aggregate({
      where: { tenantId },
      _sum: { principalAmount: true, totalRepaid: true, outstandingBalance: true },
    });
  }

  private async getSavingsTotal(tenantId: string): Promise<number> {
    const result = await this.prisma.savingsRecord.aggregate({
      where: { tenantId },
      _sum: { amount: true },
    });
    return Number(result._sum.amount ?? 0);
  }

  private async getWelfareStats(tenantId: string): Promise<{ collected: number; deficit: number }> {
    const result = await this.prisma.groupWelfareCollection.aggregate({
      where: { tenantId },
      _sum: { amountCollected: true, deficit: true },
    });
    return {
      collected: Number(result._sum.amountCollected ?? 0),
      deficit: Number(result._sum.deficit ?? 0),
    };
  }

  private async getRecentDisbursements(tenantId: string): Promise<RecentDisbursement[]> {
    const loans = await this.prisma.loan.findMany({
      where: { tenantId, status: { in: ['DISBURSED', 'ACTIVE'] } },
      orderBy: { disbursedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        principalAmount: true,
        disbursedAt: true,
        status: true,
        member: { select: { memberNumber: true } },
      },
    });

    return loans.map((l) => ({
      loanId: l.id,
      memberNumber: l.member.memberNumber,
      principal: Number(l.principalAmount),
      disbursedAt: l.disbursedAt?.toISOString() ?? '',
      status: l.status,
    }));
  }

  private async getRepaymentHeatmap(tenantId: string): Promise<RepaymentHeatmapEntry[]> {
    const result = await this.prisma.loanRepayment.groupBy({
      by: ['dayNumber'],
      where: { tenantId },
      _sum: { amountPaid: true },
      _count: { id: true },
      orderBy: { dayNumber: 'asc' },
    });

    return result.map((r) => ({
      dayNumber: r.dayNumber,
      totalPaid: Number(r._sum.amountPaid ?? 0),
      count: r._count.id,
    }));
  }

  private async getStageWelfareTable(tenantId: string): Promise<StageWelfareEntry[]> {
    const collections = await this.prisma.groupWelfareCollection.findMany({
      where: { tenantId },
      orderBy: [{ weekNumber: 'desc' }],
      take: 20,
      include: { group: { select: { name: true, weeklyTarget: true } } },
    });

    return collections.map((c) => ({
      stageName: c.group.name,
      weekNumber: c.weekNumber,
      amountCollected: Number(c.amountCollected),
      weeklyTarget: Number(c.group.weeklyTarget),
      deficit: Number(c.deficit),
    }));
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
