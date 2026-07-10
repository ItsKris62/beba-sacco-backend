import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { Decimal } from 'decimal.js';
import {
  AccountType,
  AccountStatus,
  DocumentStatus,
  DocumentType,
  KycStatus,
  LoanStatus,
  StagePosition,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DOMAIN_EVENTS, DomainEventName } from '../../common/constants/events';
import { RedisService } from '../../common/services/redis.service';
import { CacheService } from '../../common/services/cache.service';
import { QUEUE_NAMES, type EmailJobPayload } from '../queue/queue.constants';
import { UpdateKycDto } from './dto/update-kyc.dto';
import { ReviewMemberDto, ReviewAction } from './dto/review-member.dto';
import { GetTransactionsQueryDto } from './dto/get-transactions.dto';
import { FeatureFlags } from '../../config/feature-flags';
import { resolveKycStatus, toBusinessStatus } from '../members/member.types';
import { recordSaccoMetric } from '../../common/sentry/sacco-tracing';

const STATS_CACHE_TTL = 60; // 60 seconds
const REQUIRED_KYC_DOCUMENT_TYPES: DocumentType[] = [
  DocumentType.NATIONAL_ID_FRONT,
  DocumentType.NATIONAL_ID_BACK,
  DocumentType.KRA_PIN,
  DocumentType.MEMBER_FORM,
];

const TRANSACTION_INFLOW_TYPES: TransactionType[] = [
  TransactionType.DEPOSIT,
  TransactionType.INTEREST_EARNED,
  TransactionType.DIVIDEND_PAYOUT,
  TransactionType.LOAN_DISBURSEMENT,
];

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
    private readonly cache: CacheService,
    @InjectQueue(QUEUE_NAMES.EMAIL) private readonly emailQueue: Queue,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private emitDomainEvent(eventName: DomainEventName, payload: Record<string, unknown>): void {
    try {
      this.eventEmitter.emit(eventName, payload);
    } catch (error: unknown) {
      this.logger.error(
        `Domain event emit failed (${eventName}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

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
      try {
        return JSON.parse(cached) as ReturnType<typeof this.computeDashboardStats>;
      } catch {
        /* fallthrough to fresh query */
      }
    }

    const stats = await this.computeDashboardStats(tenantId);
    await this.redis.set(cacheKey, JSON.stringify(stats), STATS_CACHE_TTL);
    return stats;
  }

  /** Invalidate the dashboard stats cache for a tenant (call after KYC / loan changes). */
  async invalidateDashboardCache(tenantId: string): Promise<void> {
    await this.redis.del(`admin:stats:${tenantId}`);
  }

  // ─── TRANSACTIONS ─────────────────────────────────────────────

  /**
   * Paginated transaction list scoped to a tenant.
   * SUPER_ADMIN may pass tenantId = undefined to query across all tenants.
   */
  async getTransactions(tenantId: string | undefined, query: GetTransactionsQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = {
      ...(tenantId && { tenantId }),
      ...(query.type && { type: query.type }),
      ...(query.status && { status: query.status }),
      ...((query.from || query.to) && {
        createdAt: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lte: new Date(query.to) }),
        },
      }),
      ...(query.search && {
        OR: [
          { reference: { contains: query.search, mode: 'insensitive' as const } },
          { account: { accountNumber: { contains: query.search, mode: 'insensitive' as const } } },
        ],
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          account: {
            select: {
              id: true,
              accountNumber: true,
              accountType: true,
              member: {
                select: {
                  id: true,
                  memberNumber: true,
                  user: { select: { firstName: true, lastName: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return {
      data: data.map((tx) => ({
        ...tx,
        amount: tx.amount.toNumber(),
        balanceBefore: tx.balanceBefore.toNumber(),
        balanceAfter: tx.balanceAfter.toNumber(),
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Aggregates completed transaction flow for the selected tenant and filters.
   *
   * The totals are independent of the paginated transaction table, so dashboard
   * cards do not accidentally report only the current page.
   */
  async getTransactionStats(
    tenantId: string | undefined,
    query: { from?: string; to?: string; search?: string },
  ) {
    const periodStart = query.from ? new Date(query.from) : null;
    const periodEnd = query.to ? new Date(query.to) : null;
    const where = {
      ...(tenantId && { tenantId }),
      status: TransactionStatus.COMPLETED,
      ...((periodStart || periodEnd) && {
        createdAt: {
          ...(periodStart && { gte: periodStart }),
          ...(periodEnd && { lte: periodEnd }),
        },
      }),
      ...(query.search && {
        OR: [
          { reference: { contains: query.search, mode: 'insensitive' as const } },
          { account: { accountNumber: { contains: query.search, mode: 'insensitive' as const } } },
        ],
      }),
    };

    const grouped = await this.prisma.transaction.groupBy({
      by: ['type'],
      where,
      _sum: { amount: true },
    });

    let inflows = new Decimal(0);
    let outflows = new Decimal(0);

    for (const row of grouped) {
      const amount = new Decimal(row._sum.amount?.toString() ?? 0);
      if (TRANSACTION_INFLOW_TYPES.includes(row.type)) {
        inflows = inflows.plus(amount);
      } else {
        outflows = outflows.plus(amount);
      }
    }

    return {
      pageVolume: inflows.plus(outflows).toNumber(),
      inflows: inflows.toNumber(),
      outflows: outflows.toNumber(),
      netFlow: inflows.minus(outflows).toNumber(),
      periodStart: periodStart?.toISOString() ?? null,
      periodEnd: periodEnd?.toISOString() ?? null,
    };
  }

  private async computeDashboardStats(tenantId: string) {
    const now = new Date();
    const minus7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const minus30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalMembers,
      totalActiveAccounts,
      engagedUsers30d,
      pendingKyc,
      totalLoans,
      activeLoans,
      pendingLoans,
      defaultedLoans,
      mpesa7d,
      mpesa30d,
    ] = await this.prisma.$transaction([
      this.prisma.member.count({ where: { tenantId } }),
      this.prisma.user.count({ where: { tenantId, accountStatus: AccountStatus.ACTIVE } }),
      this.prisma.user.count({ where: { tenantId, lastLoginAt: { gte: minus30d } } }),
      this.prisma.member.count({ where: { tenantId, kycStatus: KycStatus.PENDING_REVIEW } }),
      this.prisma.loan.count({ where: { tenantId } }),
      this.prisma.loan.findMany({
        where: { tenantId, status: LoanStatus.ACTIVE },
        select: { outstandingBalance: true },
      }),
      this.prisma.loan.count({
        where: {
          tenantId,
          status: {
            in: [
              LoanStatus.PENDING_APPROVAL,
              LoanStatus.PENDING_GUARANTORS,
              LoanStatus.PENDING_REVIEW,
            ],
          },
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

    const defaultRate = totalLoans > 0 ? ((defaultedLoans / totalLoans) * 100).toFixed(2) : '0.00';

    return {
      members: {
        total: totalMembers,
        totalActiveAccounts,
        engagedUsers30d,
        pendingKyc,
      },
      loans: {
        total: totalLoans,
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
      accountStatus?: AccountStatus;
      recentlyActive?: boolean;
      role?: UserRole;
    },
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = {
      tenantId,
      ...(opts.accountStatus && { user: { accountStatus: opts.accountStatus } }),
      ...(opts.recentlyActive && {
        user: { lastLoginAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      }),
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
              accountStatus: true,
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

  // ─── PENDING KYC QUEUE ────────────────────────────────────────

  /**
   * Returns members whose KYC is awaiting staff review, oldest first (FIFO).
   * Only TENANT_ADMIN / MANAGER should call this via the controller.
   */
  async getPendingMembers(
    tenantId: string,
    opts: { search?: string; page?: number; limit?: number } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = {
      tenantId,
      kycStatus: KycStatus.PENDING_REVIEW,
      ...(opts.search && {
        OR: [
          { memberNumber: { contains: opts.search, mode: 'insensitive' as const } },
          { user: { firstName: { contains: opts.search, mode: 'insensitive' as const } } },
          { user: { lastName: { contains: opts.search, mode: 'insensitive' as const } } },
          { user: { email: { contains: opts.search, mode: 'insensitive' as const } } },
          { nationalId: { contains: opts.search, mode: 'insensitive' as const } },
        ],
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.member.findMany({
        where,
        skip,
        take: limit,
        orderBy: { joinedAt: 'asc' }, // FIFO – oldest submission reviewed first
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              createdAt: true,
            },
          },
        },
      }),
      this.prisma.member.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ─── KYC REVIEW (APPROVE / REJECT) ───────────────────────────

  /**
   * Approve or reject a member's KYC submission.
   *
   * APPROVE path (atomic transaction):
   *   1. Set kycStatus = APPROVED, record reviewer + timestamp
   *   2. Increment TenantCounter.accountSeq by 2 (FOSA + BOSA)
   *   3. Create FOSA account (ACC-FOSA-XXXXXX)
   *   4. Create BOSA account (ACC-BOSA-XXXXXX)
   *
   * REJECT path:
   *   1. Set kycStatus = REJECTED, store reason + reviewer + timestamp
   *
   * Both paths:
   *   - Enqueue email notification (fire-and-forget)
   *   - Audit log
   *   - Invalidate dashboard cache
   */
  async reviewMember(
    memberId: string,
    dto: ReviewMemberDto,
    tenantId: string,
    actor: { id: string; role: UserRole },
    ipAddress?: string,
    userAgent?: string,
  ) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, tenantId, kycStatus: KycStatus.PENDING_REVIEW },
      include: {
        user: { select: { email: true, firstName: true, lastName: true } },
      },
    });
    if (!member) {
      throw new NotFoundException('Pending member not found - may already have been reviewed');
    }

    if (dto.action === ReviewAction.APPROVE) {
      await this.assertMemberHasApprovedKycDocuments(tenantId, memberId);
    } else if (!dto.reason?.trim()) {
      throw new BadRequestException('A rejection reason is required');
    }

    await this.prisma.$transaction(async (tx) => {
      const oldValue = await tx.member.findFirst({
        where: { id: memberId, tenantId },
        select: {
          id: true,
          memberNumber: true,
          kycStatus: true,
          kycReviewedAt: true,
          kycReviewedByUserId: true,
          kycRejectionReason: true,
        },
      });
      if (!oldValue) throw new NotFoundException('Member not found');

      const reviewedAt = new Date();
      const updated = await tx.member.update({
        where: { id: memberId },
        data:
          dto.action === ReviewAction.APPROVE
            ? {
                kycStatus: KycStatus.APPROVED,
                kycReviewedAt: reviewedAt,
                kycReviewedByUserId: actor.id,
                kycRejectionReason: null,
              }
            : {
                kycStatus: KycStatus.REJECTED,
                kycReviewedAt: reviewedAt,
                kycReviewedByUserId: actor.id,
                kycRejectionReason: dto.reason!.trim(),
              },
        select: {
          id: true,
          memberNumber: true,
          kycStatus: true,
          kycReviewedAt: true,
          kycReviewedByUserId: true,
          kycRejectionReason: true,
        },
      });

      if (dto.action === ReviewAction.APPROVE) {
        // Atomically claim two account sequence numbers
        const counter = await tx.tenantCounter.upsert({
          where: { tenantId },
          update: { accountSeq: { increment: 2 } },
          create: { tenantId, memberSeq: 0, accountSeq: 2, loanSeq: 0 },
          select: { accountSeq: true },
        });

        const fosaSeq = counter.accountSeq - 1;
        const bosaSeq = counter.accountSeq;

        await tx.account.create({
          data: {
            tenantId,
            memberId,
            accountNumber: `ACC-FOSA-${String(fosaSeq).padStart(6, '0')}`,
            accountType: AccountType.FOSA,
          },
        });

        await tx.account.create({
          data: {
            tenantId,
            memberId,
            accountNumber: `ACC-BOSA-${String(bosaSeq).padStart(6, '0')}`,
            accountType: AccountType.BOSA,
          },
        });
      }

      await this.audit.logAtomic(tx, {
        tenantId,
        actorId: actor.id,
        action: dto.action === ReviewAction.APPROVE ? 'MEMBER.KYC_APPROVE' : 'MEMBER.KYC_REJECT',
        entityType: 'Member',
        entityId: memberId,
        oldValue,
        newValue: updated,
        metadata: {
          action: dto.action,
          reason: dto.reason,
          reviewedBy: actor.id,
          actorRole: actor.role,
        },
        ipAddress,
        userAgent,
      });
    });

    const kycStatus = dto.action === ReviewAction.APPROVE ? KycStatus.APPROVED : KycStatus.REJECTED;
    this.emitDomainEvent(DOMAIN_EVENTS.KYC.STATUS_CHANGED, {
      tenantId,
      memberId,
      kycStatus,
      actorId: actor.id,
    });
    this.emitDomainEvent(
      dto.action === ReviewAction.APPROVE ? DOMAIN_EVENTS.KYC.APPROVED : DOMAIN_EVENTS.KYC.REJECTED,
      {
        tenantId,
        memberId,
        kycStatus,
        actorId: actor.id,
      },
    );

    if (dto.action === ReviewAction.APPROVE) {
      this.emitDomainEvent(DOMAIN_EVENTS.MEMBER.ACCOUNT_ACTIVATED, {
        tenantId,
        memberId,
        actorId: actor.id,
      });
      await this.emailQueue
        .add('send', {
          type: 'MEMBER_APPROVED',
          to: member.user.email,
          firstName: member.user.firstName,
          saccoName: 'Your SACCO', // Phase 3: resolve from tenant.name
          memberNumber: member.memberNumber,
        } satisfies EmailJobPayload)
        .catch((e: unknown) => this.logger.error('Email enqueue failed (non-fatal)', e));
      recordSaccoMetric('sacco.kyc.approved', 1, {
        tenantId,
        memberId,
        flow: 'reviewMember',
      });
    } else {
      await this.emailQueue
        .add('send', {
          type: 'MEMBER_REJECTED',
          to: member.user.email,
          firstName: member.user.firstName,
          reason: dto.reason!.trim(),
        } satisfies EmailJobPayload)
        .catch((e: unknown) => this.logger.error('Email enqueue failed (non-fatal)', e));
    }

    await this.invalidateDashboardCache(tenantId);

    return { success: true, action: dto.action };
  }
  // ─── KYC UPDATE ──────────────────────────────────────────────

  async updateKyc(
    memberId: string,
    dto: UpdateKycDto,
    tenantId: string,
    updatedBy: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const aliasStatus = this.resolveRequestedKycStatus(tenantId, dto);
    const effectiveVerified =
      aliasStatus === KycStatus.APPROVED
        ? true
        : aliasStatus === KycStatus.REJECTED
          ? false
          : dto.verified;

    const member = await this.prisma.member.findFirst({
      where: { id: memberId, tenantId },
      select: {
        id: true,
        userId: true,
        user: { select: { wardId: true } },
      },
    });
    if (!member) throw new NotFoundException('Member not found');

    if (effectiveVerified === true) {
      if (!dto.documentIds?.length) {
        throw new BadRequestException('Approved KYC document IDs are required for approval');
      }
      await this.assertApprovedKycDocuments(tenantId, memberId, dto.documentIds);
      this.assertKycChecklistComplete(dto.checklist);
    }
    if (effectiveVerified === false && !dto.notes?.trim()) {
      throw new BadRequestException('Reviewer notes are required when rejecting KYC');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const before = await tx.member.findFirst({
        where: { id: memberId, tenantId },
        select: {
          id: true,
          nationalId: true,
          kraPin: true,
          employer: true,
          occupation: true,
          dateOfBirth: true,
          kycStatus: true,
          kycChecklist: true,
          kycReviewNotes: true,
          kycReviewedAt: true,
          kycReviewedByUserId: true,
          kycRejectionReason: true,
        },
      });
      if (!before) throw new NotFoundException('Member not found');

      const reviewedAt = effectiveVerified === undefined && !aliasStatus ? undefined : new Date();
      const memberUpdate = await tx.member.update({
        where: { id: memberId },
        data: {
          ...(dto.nationalId !== undefined && { nationalId: dto.nationalId }),
          ...(dto.kraPin !== undefined && { kraPin: dto.kraPin }),
          ...(dto.employer !== undefined && { employer: dto.employer }),
          ...(dto.occupation !== undefined && { occupation: dto.occupation }),
          ...(dto.dateOfBirth !== undefined && { dateOfBirth: new Date(dto.dateOfBirth) }),
          ...(dto.checklist !== undefined && { kycChecklist: dto.checklist }),
          ...(dto.notes !== undefined && { kycReviewNotes: dto.notes.trim() }),
          ...(effectiveVerified === true && {
            kycStatus: KycStatus.APPROVED,
            kycReviewedAt: reviewedAt,
            kycReviewedByUserId: updatedBy,
            kycRejectionReason: null,
          }),
          ...(effectiveVerified === false && {
            kycStatus: KycStatus.REJECTED,
            kycReviewedAt: reviewedAt,
            kycReviewedByUserId: updatedBy,
            kycRejectionReason: dto.notes?.trim(),
          }),
          ...(aliasStatus &&
            effectiveVerified === undefined && {
              kycStatus: aliasStatus,
              kycReviewedAt: reviewedAt,
              kycReviewedByUserId: updatedBy,
              kycRejectionReason: null,
            }),
        },
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
        },
      });

      if (dto.phone !== undefined || dto.nextOfKinPhone !== undefined) {
        await tx.user.update({
          where: { id: member.userId },
          data: {
            ...(dto.phone !== undefined && { phone: dto.phone, phoneNumber: dto.phone }),
            ...(dto.nextOfKinPhone !== undefined && { nextOfKinPhone: dto.nextOfKinPhone }),
          },
        });
      }

      let stageTransition: { from: string | null; to: string } | undefined;
      if (dto.stageId || dto.stageName) {
        if (!dto.stageId && !member.user.wardId) {
          throw new BadRequestException('Member ward is required when resolving a stage by name');
        }

        const targetStage = dto.stageId
          ? await tx.stage.findFirst({
              where: { id: dto.stageId, tenantId },
              select: { id: true, name: true },
            })
          : await tx.stage.upsert({
              where: {
                name_wardId_tenantId: {
                  name: dto.stageName!.trim(),
                  wardId: member.user.wardId!,
                  tenantId,
                },
              },
              create: {
                name: dto.stageName!.trim(),
                wardId: member.user.wardId!,
                tenantId,
              },
              update: {},
              select: { id: true, name: true },
            });

        if (!targetStage) {
          throw new NotFoundException('Target stage not found for this tenant');
        }

        const currentStage = await tx.memberStage.findFirst({
          where: { memberId, isActive: true },
          select: { stage: { select: { name: true } } },
        });

        await tx.memberStage.updateMany({
          where: { memberId, isActive: true },
          data: { isActive: false },
        });
        await tx.stageAssignment.updateMany({
          where: { userId: member.userId, isActive: true },
          data: { isActive: false },
        });

        await tx.memberStage.upsert({
          where: { memberId_stageId: { memberId, stageId: targetStage.id } },
          create: {
            memberId,
            stageId: targetStage.id,
            assignedBy: updatedBy,
            isActive: true,
          },
          update: {
            assignedBy: updatedBy,
            assignedAt: new Date(),
            isActive: true,
          },
        });

        await tx.stageAssignment.upsert({
          where: { userId_stageId: { userId: member.userId, stageId: targetStage.id } },
          create: {
            userId: member.userId,
            stageId: targetStage.id,
            position: StagePosition.MEMBER,
            isActive: true,
          },
          update: {
            position: StagePosition.MEMBER,
            isActive: true,
          },
        });

        stageTransition = {
          from: currentStage?.stage.name ?? null,
          to: targetStage.name,
        };
      }

      if (effectiveVerified === true) {
        const existingAccounts = await tx.account.findMany({
          where: { tenantId, memberId, accountType: { in: [AccountType.FOSA, AccountType.BOSA] } },
          select: { accountType: true },
        });
        const existingTypes = new Set(existingAccounts.map((account) => account.accountType));
        const missingTypes = [AccountType.FOSA, AccountType.BOSA].filter(
          (type) => !existingTypes.has(type),
        );

        if (missingTypes.length > 0) {
          const counter = await tx.tenantCounter.upsert({
            where: { tenantId },
            update: { accountSeq: { increment: missingTypes.length } },
            create: { tenantId, memberSeq: 0, accountSeq: missingTypes.length, loanSeq: 0 },
            select: { accountSeq: true },
          });
          const firstSeq = counter.accountSeq - missingTypes.length + 1;
          await Promise.all(
            missingTypes.map((accountType, index) =>
              tx.account.create({
                data: {
                  tenantId,
                  memberId,
                  accountNumber: `ACC-${accountType}-${String(firstSeq + index).padStart(6, '0')}`,
                  accountType,
                },
              }),
            ),
          );
        }
      }

      await this.audit.logAtomic(tx, {
        tenantId,
        actorId: updatedBy,
        action: 'MEMBER.KYC_UPDATE',
        entityType: 'Member',
        entityId: memberId,
        oldValue: before,
        newValue: {
          id: memberUpdate.id,
          nationalId: memberUpdate.nationalId,
          kraPin: memberUpdate.kraPin,
          employer: memberUpdate.employer,
          occupation: memberUpdate.occupation,
          dateOfBirth: memberUpdate.dateOfBirth,
          kycStatus: memberUpdate.kycStatus,
          kycChecklist: memberUpdate.kycChecklist,
          kycReviewNotes: memberUpdate.kycReviewNotes,
          kycReviewedAt: memberUpdate.kycReviewedAt,
          kycReviewedByUserId: memberUpdate.kycReviewedByUserId,
          kycRejectionReason: memberUpdate.kycRejectionReason,
        },
        metadata: {
          stageTransition,
          kycDecision:
            dto.verified === undefined ? 'PROFILE_UPDATE' : dto.verified ? 'APPROVED' : 'REJECTED',
          kycStatusAliasEnabled: FeatureFlags.isEnabled('KYC_STATUS_ALIAS', tenantId),
          requestedStatus: dto.statusAlias ?? dto.status,
          documentIds: dto.documentIds?.map((id) => ({ id })),
        },
        ipAddress,
        userAgent,
      });

      return { member: memberUpdate, stageTransition };
    });

    if (effectiveVerified !== undefined || aliasStatus) {
      this.emitDomainEvent(DOMAIN_EVENTS.KYC.STATUS_CHANGED, {
        tenantId,
        memberId,
        kycStatus: result.member.kycStatus,
        actorId: updatedBy,
      });
      if (result.member.kycStatus === KycStatus.APPROVED) {
        this.emitDomainEvent(DOMAIN_EVENTS.KYC.APPROVED, {
          tenantId,
          memberId,
          kycStatus: result.member.kycStatus,
          actorId: updatedBy,
        });
        this.emitDomainEvent(DOMAIN_EVENTS.MEMBER.ACCOUNT_ACTIVATED, {
          tenantId,
          memberId,
          actorId: updatedBy,
        });
      }
      if (result.member.kycStatus === KycStatus.REJECTED) {
        this.emitDomainEvent(DOMAIN_EVENTS.KYC.REJECTED, {
          tenantId,
          memberId,
          kycStatus: result.member.kycStatus,
          actorId: updatedBy,
        });
      }
    }

    if (effectiveVerified === true) {
      recordSaccoMetric('sacco.kyc.approved', 1, {
        tenantId,
        memberId,
        flow: 'updateKyc',
      });
    }

    await this.cache.invalidateTenantDashboard(tenantId);

    return this.withBusinessKycStatus(result.member, tenantId);
  }
  private resolveRequestedKycStatus(tenantId: string, dto: UpdateKycDto): KycStatus | undefined {
    if (!FeatureFlags.isEnabled('KYC_STATUS_ALIAS', tenantId)) {
      return undefined;
    }

    const requested = dto.statusAlias ?? dto.status;
    if (!requested) return undefined;

    try {
      return resolveKycStatus(requested);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Unsupported KYC status',
      );
    }
  }

  private withBusinessKycStatus<T extends { kycStatus?: KycStatus | string }>(
    member: T,
    tenantId: string,
  ): T {
    if (!FeatureFlags.isEnabled('KYC_STATUS_ALIAS', tenantId) || !member.kycStatus) {
      return member;
    }

    return {
      ...member,
      kycStatus: toBusinessStatus(member.kycStatus),
    };
  }

  private assertKycChecklistComplete(checklist?: Record<string, boolean>): void {
    if (!checklist || Object.keys(checklist).length === 0) {
      throw new BadRequestException('KYC approval checklist is required');
    }
    const incomplete = Object.entries(checklist)
      .filter(([, passed]) => passed !== true)
      .map(([key]) => key);
    if (incomplete.length > 0) {
      throw new BadRequestException(`KYC checklist incomplete: ${incomplete.join(', ')}`);
    }
  }

  private async assertApprovedKycDocuments(
    tenantId: string,
    memberId: string,
    documentIds: string[],
  ): Promise<void> {
    const documents = await this.prisma.document.findMany({
      where: {
        tenantId,
        memberId,
        id: { in: [...new Set(documentIds)] },
        status: DocumentStatus.APPROVED,
        type: { in: REQUIRED_KYC_DOCUMENT_TYPES },
      },
      select: { id: true, type: true },
    });

    const approvedTypes = new Set(documents.map((document) => document.type));
    const missing = REQUIRED_KYC_DOCUMENT_TYPES.filter((type) => !approvedTypes.has(type));
    if (missing.length > 0) {
      throw new BadRequestException(`Approved KYC documents missing: ${missing.join(', ')}`);
    }
  }

  private async assertMemberHasApprovedKycDocuments(
    tenantId: string,
    memberId: string,
  ): Promise<void> {
    const documents = await this.prisma.document.findMany({
      where: {
        tenantId,
        memberId,
        status: DocumentStatus.APPROVED,
        type: { in: REQUIRED_KYC_DOCUMENT_TYPES },
      },
      distinct: ['type'],
      select: { type: true },
    });
    const approvedTypes = new Set(documents.map((document) => document.type));
    const missing = REQUIRED_KYC_DOCUMENT_TYPES.filter((type) => !approvedTypes.has(type));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Cannot approve KYC until required documents are approved: ${missing.join(', ')}`,
      );
    }
  }
}
