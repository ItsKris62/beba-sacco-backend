import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateMemberDto } from './dto/create-member.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import type { Member, PaginatedResponse } from './members.types';
import { QUEUE_NAMES, EmailJobPayload } from '../queue/queue.constants';

/**
 * Members Service
 *
 * All operations are scoped to a tenant via tenantId.
 * memberNumber is auto-incremented per-tenant using TenantCounter.
 *
 * TODO: Phase 3 – KYC verification integration (Smile Identity / Jumio)
 * TODO: Phase 4 – member contribution/dividend tracking
 */
@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue<EmailJobPayload>,
  ) {}

  private enqueueEmail(payload: EmailJobPayload, ctx: string): void {
    this.emailQueue
      .add('send', payload, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } })
      .catch((e: unknown) =>
        this.logger.error(`[EmailQueue] enqueue failed [${ctx}]: ${e instanceof Error ? e.message : String(e)}`),
      );
  }

  // ─── CREATE ──────────────────────────────────────────────────

  async create(
    dto: CreateMemberDto,
    tenantId: string,
    createdBy: string,
    ipAddress?: string,
  ): Promise<Member> {
    // Verify the user belongs to this tenant
    const user = await this.prisma.user.findFirst({
      where: { id: dto.userId, tenantId },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    if (!user) throw new NotFoundException('User not found in this tenant');

    // Prevent duplicate member profiles
    const existing = await this.prisma.member.findUnique({ where: { userId: dto.userId } });
    if (existing) throw new ConflictException('User already has a member profile');

    // Atomic member number generation
    const counter = await this.prisma.tenantCounter.upsert({
      where: { tenantId },
      create: { tenantId, memberSeq: 1 },
      update: { memberSeq: { increment: 1 } },
    });
    const memberNumber = `M-${String(counter.memberSeq).padStart(6, '0')}`;

    const member = await this.prisma.member.create({
      data: {
        tenantId,
        userId: dto.userId,
        memberNumber,
        nationalId: dto.nationalId,
        kraPin: dto.kraPin,
        employer: dto.employer,
        occupation: dto.occupation,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
      },
      include: { user: { select: { firstName: true, lastName: true, email: true, phone: true } } },
    });

    await this.audit.create({
      tenantId,
      userId: createdBy,
      action: 'MEMBER.CREATE',
      resource: 'Member',
      resourceId: member.id,
      metadata: { memberNumber, linkedUserId: dto.userId },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    // Send welcome email to the new member
    if (user.email) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });
      this.enqueueEmail({
        type: 'WELCOME',
        to: user.email,
        firstName: user.firstName,
        saccoName: tenant?.name ?? 'Beba SACCO',
      }, `members.create:${member.id}`);
    }

    return member as Member;
  }

  // ─── LIST ────────────────────────────────────────────────────

  async findAll(
    tenantId: string,
    opts: { page?: number; limit?: number; search?: string; isActive?: boolean },
  ): Promise<PaginatedResponse<Member>> {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = {
      tenantId,
      ...(opts.isActive !== undefined && { isActive: opts.isActive }),
      ...(opts.search && {
        OR: [
          { memberNumber: { contains: opts.search, mode: 'insensitive' as const } },
          { user: { firstName: { contains: opts.search, mode: 'insensitive' as const } } },
          { user: { lastName: { contains: opts.search, mode: 'insensitive' as const } } },
          { user: { email: { contains: opts.search, mode: 'insensitive' as const } } },
        ],
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.member.findMany({
        where,
        skip,
        take: limit,
        orderBy: { joinedAt: 'desc' },
        include: { user: { select: { firstName: true, lastName: true, email: true, phone: true } } },
      }),
      this.prisma.member.count({ where }),
    ]);

    return {
      data: data as Member[],
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── FIND ONE ────────────────────────────────────────────────

  async findOne(id: string, tenantId: string): Promise<Member> {
    const member = await this.prisma.member.findFirst({
      where: { id, tenantId },
      include: {
        user: { select: { firstName: true, lastName: true, email: true, phone: true, role: true } },
        accounts: { select: { id: true, accountNumber: true, accountType: true, balance: true, isActive: true } },
        loans: {
          select: { id: true, loanNumber: true, status: true, principalAmount: true, outstandingBalance: true },
          orderBy: { appliedAt: 'desc' },
          take: 5,
        },
      },
    });
    if (!member) throw new NotFoundException('Member not found');
    return member as Member;
  }

  // ─── UPDATE ──────────────────────────────────────────────────

  async update(
    id: string,
    dto: UpdateMemberDto,
    tenantId: string,
    updatedBy: string,
    ipAddress?: string,
  ): Promise<Member> {
    await this.assertExists(id, tenantId);

    const updated = await this.prisma.member.update({
      where: { id },
      data: {
        nationalId: dto.nationalId,
        kraPin: dto.kraPin,
        employer: dto.employer,
        occupation: dto.occupation,
        isActive: dto.isActive,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
      },
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
    });

    await this.audit.create({
      tenantId,
      userId: updatedBy,
      action: 'MEMBER.UPDATE',
      resource: 'Member',
      resourceId: id,
      metadata: dto as Record<string, unknown>,
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    return updated as Member;
  }

  // ─── HELPERS ─────────────────────────────────────────────────

  private async assertExists(id: string, tenantId: string): Promise<void> {
    const exists = await this.prisma.member.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Member not found');
  }
}
