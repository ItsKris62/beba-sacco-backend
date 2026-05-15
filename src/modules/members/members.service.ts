import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateMemberDto } from './dto/create-member.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { PatchProfileDto } from './dto/patch-profile.dto';
import type { Member, PaginatedResponse } from './members.types';
import { QUEUE_NAMES, EmailJobPayload } from '../queue/queue.constants';

/**
 * Members Service
 *
 * memberNumber uses a role-prefixed random format (MBR-XXXXXX) with
 * automatic retry on the rare collision, replacing the fragile TenantCounter.
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
    const user = await this.prisma.user.findFirst({
      where: { id: dto.userId, tenantId },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    if (!user) throw new NotFoundException('User not found in this tenant');

    const existing = await this.prisma.member.findUnique({ where: { userId: dto.userId } });
    if (existing) throw new ConflictException('User already has a member profile');

    if (dto.stageIds && dto.stageIds.length > 0) {
      const stages = await this.prisma.stage.findMany({
        where: { id: { in: dto.stageIds }, tenantId },
        select: { id: true },
      });
      if (stages.length !== dto.stageIds.length) {
        throw new BadRequestException('One or more stage IDs are invalid or do not belong to this tenant');
      }
    }

    // Retry up to 3 times on the rare memberNumber collision
    const MAX_ATTEMPTS = 3;
    let member: Awaited<ReturnType<typeof this.prisma.member.create>> | undefined;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const memberNumber = this.generateMemberNumber();

      try {
        member = await this.prisma.$transaction(async (tx) => {
          const created = await tx.member.create({
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

          if (dto.stageIds && dto.stageIds.length > 0) {
            const uniqueStageIds = [...new Set(dto.stageIds)];
            await tx.memberStage.createMany({
              data: uniqueStageIds.map((stageId) => ({
                memberId: created.id,
                stageId,
                assignedBy: createdBy,
                isActive: true,
              })),
              skipDuplicates: true,
            });
          }

          return created;
        });

        break; // success
      } catch (err) {
        if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
          const fields = Array.isArray(err.meta?.target)
            ? (err.meta.target as string[]).join(', ')
            : String(err.meta?.target ?? '');

          if (fields.includes('memberNumber') && attempt < MAX_ATTEMPTS - 1) {
            this.logger.warn(`memberNumber collision on attempt ${attempt + 1}, retrying…`);
            continue;
          }
        }
        throw err;
      }
    }

    if (!member) {
      throw new InternalServerErrorException(
        'Could not generate a unique member number. Please try again.',
      );
    }

    await this.audit.create({
      tenantId,
      userId: createdBy,
      action: 'MEMBER.CREATE',
      resource: 'Member',
      resourceId: member.id,
      metadata: { memberNumber: member.memberNumber, linkedUserId: dto.userId, stageIds: dto.stageIds },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

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

  // ─── PATCH PROFILE ──────────────────────────────────────────

  async patchProfile(
    memberId: string,
    dto: PatchProfileDto,
    tenantId: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<Member> {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, tenantId },
      select: { id: true, userId: true },
    });
    if (!member) throw new NotFoundException('Member not found');

    await this.prisma.$transaction(async (tx) => {
      if (dto.phone !== undefined || dto.email !== undefined) {
        await tx.user.update({
          where: { id: member.userId },
          data: {
            ...(dto.phone !== undefined && { phone: dto.phone }),
            ...(dto.email !== undefined && { email: dto.email.toLowerCase() }),
          },
        });
      }

      if (dto.employer !== undefined || dto.occupation !== undefined) {
        await tx.member.update({
          where: { id: memberId },
          data: {
            ...(dto.employer !== undefined && { employer: dto.employer }),
            ...(dto.occupation !== undefined && { occupation: dto.occupation }),
          },
        });
      }

      if (dto.stageIds !== undefined) {
        const uniqueIds = [...new Set(dto.stageIds)];
        if (uniqueIds.length > 0) {
          const validCount = await tx.stage.count({
            where: { id: { in: uniqueIds }, tenantId },
          });
          if (validCount !== uniqueIds.length) {
            throw new BadRequestException('One or more stage IDs are invalid or do not belong to this tenant');
          }
        }
        await tx.memberStage.updateMany({
          where: { memberId, isActive: true },
          data: { isActive: false },
        });
        for (const stageId of uniqueIds) {
          await tx.memberStage.create({
            data: { memberId, stageId, assignedBy: actorId, isActive: true },
          });
        }
      }
    });

    const updated = await this.prisma.member.findFirst({
      where: { id: memberId, tenantId },
      include: { user: { select: { firstName: true, lastName: true, email: true, phone: true } } },
    });

    await this.audit.create({
      tenantId,
      userId: actorId,
      action: 'MEMBER.PATCH_PROFILE',
      resource: 'Member',
      resourceId: memberId,
      metadata: dto as unknown as Record<string, unknown>,
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    return updated as Member;
  }

  // ─── HELPERS ─────────────────────────────────────────────────

  /** Generates MBR-XXXXXX (random 6-digit suffix, always 6 digits) */
  private generateMemberNumber(): string {
    const num = Math.floor(100000 + Math.random() * 900000);
    return `MBR-${num}`;
  }

  private async assertExists(id: string, tenantId: string): Promise<void> {
    const exists = await this.prisma.member.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Member not found');
  }
}
