import {
  Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { LoanStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RedisService } from '../../common/services/redis.service';
import { UpdateKycDto } from './dto/update-kyc.dto';

const STATS_CACHE_TTL = 60; // 60 seconds

/**
 * Admin Service
 *
 * Tenant-scoped aggregated metrics and member management for TENANT_ADMIN / MANAGER roles.
 * All monetary values returned as numbers (already serialized from Decimal).
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  // ─── DASHBOARD STATS ─────────────────────────────────────────

  /**
   * Aggregate metrics for admin dashboard.
   * Returns:
   *  - Total members (active/inactive)
   *  - Active loans count + total outstanding
   *  - Pending loan approvals
   *  - Default rate
   *  - M-Pesa deposit volume (7d and 30d)
   */
  async getDashboardStats(tenantId: string) {
    const cacheKey = `admin:stats:${tenantId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached) as ReturnType<typeof this.computeDashboardStats>; }
      catch { /* fallthrough to fresh query */ }
    }

    const stats = await this.computeDashboardStats(tenantId);
    await this.redis.set(cacheKey, JSON.stringify(stats), STATS_CACHE_TTL);
    return stats;
  }

  /** Invalidate the dashboard stats cache for a tenant (call after KYC / loan changes). */
  async invalidateDashboardCache(tenantId: string): Promise<void> {
    await this.redis.del(`admin:stats:${tenantId}`);
  }

  private async computeDashboardStats(tenantId: string) {
    const now = new Date();
    const minus7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const minus30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalMembers,
      activeMembers,
      totalLoans,
      activeLoans,
      pendingLoans,
      defaultedLoans,
      mpesa7d,
      mpesa30d,
    ] = await this.prisma.$transaction([
      this.prisma.member.count({ where: { tenantId } }),
      this.prisma.member.count({ where: { tenantId, isActive: true } }),
      this.prisma.loan.count({ where: { tenantId } }),
      this.prisma.loan.findMany({
        where: { tenantId, status: LoanStatus.ACTIVE },
        select: { outstandingBalance: true },
      }),
      this.prisma.loan.count({
        where: {
          tenantId,
          status: { in: [LoanStatus.PENDING_APPROVAL, LoanStatus.PENDING_GUARANTORS, LoanStatus.UNDER_REVIEW] },
        },
      }),
      this.prisma.loan.count({ where: { tenantId, status: LoanStatus.DEFAULTED } }),
      this.prisma.mpesaTransaction.aggregate({
        where: { tenantId, status: 'COMPLETED', createdAt: { gte: minus7d } },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.mpesaTransaction.aggregate({
        where: { tenantId, status: 'COMPLETED', createdAt: { gte: minus30d } },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    const totalActiveLoanAmount = activeLoans.reduce(
      (sum, l) => sum.plus(l.outstandingBalance.toString()),
      new Decimal(0),
    );

    const defaultRate =
      totalLoans > 0 ? ((defaultedLoans / totalLoans) * 100).toFixed(2) : '0.00';

    return {
      members: {
        total: totalMembers,
        active: activeMembers,
        inactive: totalMembers - activeMembers,
      },
      loans: {
        active: activeLoans.length,
        totalOutstandingAmount: totalActiveLoanAmount.toNumber(),
        pendingApprovals: pendingLoans,
        defaulted: defaultedLoans,
        defaultRatePercent: parseFloat(defaultRate),
      },
      mpesa: {
        deposits7d: {
          count: mpesa7d._count,
          totalAmount: mpesa7d._sum.amount
            ? new Decimal(mpesa7d._sum.amount.toString()).toNumber()
            : 0,
        },
        deposits30d: {
          count: mpesa30d._count,
          totalAmount: mpesa30d._sum.amount
            ? new Decimal(mpesa30d._sum.amount.toString()).toNumber()
            : 0,
        },
      },
    };
  }

  // ─── MEMBER LIST ─────────────────────────────────────────────

  async getMembers(
    tenantId: string,
    opts: {
      search?: string;
      page?: number;
      limit?: number;
      status?: 'active' | 'inactive';
      role?: UserRole;
    },
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = {
      tenantId,
      ...(opts.status === 'active' && { isActive: true }),
      ...(opts.status === 'inactive' && { isActive: false }),
      ...(opts.search && {
        OR: [
          { memberNumber: { contains: opts.search, mode: 'insensitive' as const } },
          { user: { firstName: { contains: opts.search, mode: 'insensitive' as const } } },
          { user: { lastName: { contains: opts.search, mode: 'insensitive' as const } } },
          { user: { email: { contains: opts.search, mode: 'insensitive' as const } } },
          { nationalId: { contains: opts.search, mode: 'insensitive' as const } },
        ],
      }),
      ...(opts.role && { user: { role: opts.role } }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.member.findMany({
        where,
        skip,
        take: limit,
        orderBy: { joinedAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              role: true,
              isActive: true,
              emailVerified: true,
              lastLoginAt: true,
            },
          },
          _count: { select: { loans: true, accounts: true } },
        },
      }),
      this.prisma.member.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── KYC UPDATE ──────────────────────────────────────────────

  async updateKyc(
    memberId: string,
    dto: UpdateKycDto,
    tenantId: string,
    updatedBy: string,
    ipAddress?: string,
  ) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, tenantId },
      select: { id: true, userId: true },
    });
    if (!member) throw new NotFoundException('Member not found');

    // Snapshot before state for audit
    const before = await this.prisma.member.findFirst({
      where: { id: memberId },
      select: { nationalId: true, kraPin: true, employer: true, occupation: true, dateOfBirth: true },
    });

    // Update member fields
    const updatedMember = await this.prisma.member.update({
      where: { id: memberId },
      data: {
        ...(dto.nationalId !== undefined && { nationalId: dto.nationalId }),
        ...(dto.kraPin !== undefined && { kraPin: dto.kraPin }),
        ...(dto.employer !== undefined && { employer: dto.employer }),
        ...(dto.occupation !== undefined && { occupation: dto.occupation }),
        ...(dto.dateOfBirth !== undefined && { dateOfBirth: new Date(dto.dateOfBirth) }),
      },
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
      },
    });

    // Update phone on User record if provided
    if (dto.phone) {
      await this.prisma.user.update({
        where: { id: member.userId },
        data: { phone: dto.phone },
      });
    }

    await this.audit.create({
      tenantId,
      userId: updatedBy,
      action: 'MEMBER.KYC_UPDATE',
      resource: 'Member',
      resourceId: memberId,
      metadata: { before, after: dto },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    return updatedMember;
  }
}
