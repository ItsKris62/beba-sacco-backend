import {
  Injectable, Logger, NotFoundException, ConflictException,
  ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomInt } from 'crypto';
import * as argon2 from 'argon2';
import { UserRole, AccountStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { QUEUE_NAMES, EmailJobPayload } from '../queue/queue.constants';

/** Roles that can be created/managed within a tenant context. */
const TENANT_MANAGEABLE_ROLES: UserRole[] = [
  UserRole.TENANT_ADMIN,
  UserRole.MANAGER,
  UserRole.TELLER,
  UserRole.AUDITOR,
  UserRole.MEMBER,
  UserRole.CHAIRMAN,
];

/**
 * Roles that a MANAGER is allowed to manage.
 * MANAGER cannot create or modify TENANT_ADMIN accounts — only TENANT_ADMIN can.
 */
const MANAGER_MANAGEABLE_ROLES: UserRole[] = [
  UserRole.TELLER,
  UserRole.MEMBER,
  UserRole.CHAIRMAN,
  UserRole.AUDITOR,
];

const TEMP_PASSWORD_UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const TEMP_PASSWORD_LOWER = 'abcdefghjkmnpqrstuvwxyz';
const TEMP_PASSWORD_DIGITS = '23456789';
const TEMP_PASSWORD_SYMBOLS = '@#$!';
const TEMP_PASSWORD_ALL =
  TEMP_PASSWORD_UPPER + TEMP_PASSWORD_LOWER + TEMP_PASSWORD_DIGITS + TEMP_PASSWORD_SYMBOLS;

const USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  role: true,
  role: true,
  accountStatus: true,
  mustChangePassword: true,
  lastLoginAt: true,
  emailVerified: true,
  createdById: true,
  approvedById: true,
  approvedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
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

  // ─── CREATE (admin channel) ──────────────────────────────────

  /**
   * Create a staff/member account with a temporary password.
   * mustChangePassword is forced to true — user must change on first login.
   *
   * Role restrictions:
   *   - SUPER_ADMIN cannot be assigned via this endpoint (platform-only role)
   *   - MANAGER cannot create TENANT_ADMIN accounts (role hierarchy)
   *   - TENANT_ADMIN can create any tenant-level role
   *
   * New users are created with status PENDING (explicit approval workflow).
   */
  async create(
    dto: CreateUserDto,
    tenantId: string,
    actor: { id: string; role: UserRole },
    ipAddress?: string,
  ) {
    if (dto.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('SUPER_ADMIN cannot be assigned via this endpoint');
    }

    // MANAGER cannot promote someone to TENANT_ADMIN
    if (
      actor.role === UserRole.MANAGER &&
      !MANAGER_MANAGEABLE_ROLES.includes(dto.role)
    ) {
      throw new ForbiddenException(
        `MANAGER cannot create accounts with role ${dto.role}`,
      );
    }

    const existing = await this.prisma.user.findFirst({
      where: { email: dto.email.toLowerCase() },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    const user = await this.prisma.user.create({
      data: {
        tenantId,
        email: dto.email.toLowerCase(),
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        role: dto.role,
        accountStatus: AccountStatus.ACTIVE,
        mustChangePassword: true,
        createdById: actor.id,
      },
      select: USER_SELECT,
    });

    await this.auditSafe({
      tenantId,
      actorId: actor.id,
      action: 'USER.CREATED',
      entityType: 'User',
      entityId: user.id,
      newValue: { email: user.email, role: user.role, accountStatus: user.accountStatus, createdById: actor.id },
      metadata: { ipAddress },
      ipAddress,
    });

    return user;
  }

  // ─── LIST ────────────────────────────────────────────────────

  async findAll(
    tenantId: string,
    opts: { page?: number; limit?: number; search?: string; role?: UserRole; accountStatus?: AccountStatus } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = {
      tenantId,
      ...(opts.role && { role: opts.role }),
      ...(opts.accountStatus && { accountStatus: opts.accountStatus }),
      ...(opts.search && {
        OR: [
          { firstName: { contains: opts.search, mode: 'insensitive' as const } },
          { lastName: { contains: opts.search, mode: 'insensitive' as const } },
          { email: { contains: opts.search, mode: 'insensitive' as const } },
        ],
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: USER_SELECT,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ─── FIND ONE ────────────────────────────────────────────────

  async findOne(id: string, tenantId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, tenantId },
      select: {
        ...USER_SELECT,
        member: {
          select: {
            id: true,
            memberNumber: true,
            isActive: true,
            _count: { select: { accounts: true, loans: true } },
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  // ─── UPDATE ──────────────────────────────────────────────────

  async update(
    id: string,
    dto: UpdateUserDto,
    tenantId: string,
    actor: { id: string; role: UserRole },
    ipAddress?: string,
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id, tenantId },
      select: { id: true, role: true, accountStatus: true, email: true },
    });
    if (!target) throw new NotFoundException('User not found');

    // Hard block: SUPER_ADMIN can never be assigned via this endpoint
    if (dto.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('SUPER_ADMIN cannot be assigned via this endpoint');
    }

    // MANAGER cannot elevate a user to TENANT_ADMIN, nor modify an existing TENANT_ADMIN
    if (actor.role === UserRole.MANAGER) {
      if (target.role === UserRole.TENANT_ADMIN) {
        throw new ForbiddenException('MANAGER cannot modify a TENANT_ADMIN account');
      }
      if (dto.role !== undefined && !MANAGER_MANAGEABLE_ROLES.includes(dto.role)) {
        throw new ForbiddenException(`MANAGER cannot assign role ${dto.role}`);
      }
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.role !== undefined && { role: dto.role }),
      },
      select: USER_SELECT,
    });

    await this.auditSafe({
      tenantId,
      actorId: actor.id,
      action: dto.role !== undefined ? 'ROLE_CHANGED' : 'USER.UPDATED',
      entityType: 'User',
      entityId: id,
      oldValue: { role: target.role },
      newValue: { role: updated.role },
      metadata: { changes: dto, actorRole: actor.role, ipAddress },
      ipAddress,
    });

    return updated;
  }

  // ─── UPDATE STATUS (Approval Workflow) ───────────────────────

  /**
   * Explicit approval state machine.
   *
   * Valid transitions:
   *   PENDING   → APPROVED
   *   PENDING   → REJECTED
   *   APPROVED  → SUSPENDED
   *   SUSPENDED → APPROVED
   *
   * Only MANAGER, TENANT_ADMIN, SUPER_ADMIN can change status.
   */
  async updateStatus(
    id: string,
    dto: UpdateUserStatusDto,
    tenantId: string,
    actor: { id: string; role: UserRole },
    ipAddress?: string,
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id, tenantId },
      select: { id: true, accountStatus: true, email: true, role: true },
    });
    if (!target) throw new NotFoundException('User not found');

    const validTransitions: Record<AccountStatus, AccountStatus[]> = {
      [AccountStatus.PENDING]: [AccountStatus.ACTIVE, AccountStatus.REJECTED],
      [AccountStatus.ACTIVE]: [AccountStatus.SUSPENDED],
      [AccountStatus.REJECTED]: [],
      [AccountStatus.SUSPENDED]: [AccountStatus.ACTIVE],
    };

    const allowed = validTransitions[target.accountStatus];
    if (!allowed.includes(dto.status as unknown as AccountStatus)) {
      throw new BadRequestException(
        `Invalid status transition: ${target.accountStatus} → ${dto.status}. Allowed: [${allowed.join(', ')}]`,
      );
    }

    // Idempotency check
    if (dto.idempotencyKey) {
      const idem = await this.idempotency.checkAndReserve(
        dto.idempotencyKey,
        tenantId,
        3600,
      );
      if (idem.status === 'COMPLETED') {
        return idem.result;
      }
      if (idem.status === 'PROCESSING') {
        throw new BadRequestException('Request is already being processed');
      }
    }

    const oldStatus = target.accountStatus;
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        accountStatus: dto.status as unknown as AccountStatus,
        approvedById: actor.id,
        approvedAt: new Date(),
        approvalReason: dto.reason ?? null,
      },
      select: USER_SELECT,
    });

    await this.auditSafe({
      tenantId,
      actorId: actor.id,
      action: 'STATUS_CHANGED',
      entityType: 'User',
      entityId: id,
      oldValue: { accountStatus: oldStatus },
      newValue: { accountStatus: updated.accountStatus, approvedById: actor.id, approvedAt: updated.approvedAt, reason: dto.reason },
      metadata: { ipAddress, actorRole: actor.role },
      ipAddress,
    });

    const result = { success: true, user: updated };

    if (dto.idempotencyKey) {
      await this.idempotency.complete(dto.idempotencyKey, tenantId, result, 3600);
    }

    return result;
  }

  // ─── DEACTIVATE ──────────────────────────────────────────────

  async deactivate(
    id: string,
    tenantId: string,
    actor: { id: string; role: UserRole },
    ipAddress?: string,
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id, tenantId },
      select: { id: true, accountStatus: true, role: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.accountStatus !== AccountStatus.ACTIVE) throw new BadRequestException('User is not active');

    if (id === actor.id) {
      throw new ForbiddenException('Cannot deactivate your own account');
    }

    // MANAGER cannot deactivate a TENANT_ADMIN
    if (actor.role === UserRole.MANAGER && target.role === UserRole.TENANT_ADMIN) {
      throw new ForbiddenException('MANAGER cannot deactivate a TENANT_ADMIN account');
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { accountStatus: AccountStatus.SUSPENDED, refreshToken: null },
      select: USER_SELECT,
    });

    await this.auditSafe({
      tenantId,
      actorId: actor.id,
      action: 'USER.DEACTIVATED',
      entityType: 'User',
      entityId: id,
      oldValue: { accountStatus: AccountStatus.ACTIVE },
      newValue: { accountStatus: AccountStatus.SUSPENDED },
      metadata: { targetRole: target.role, ipAddress },
      ipAddress,
    });

    return updated;
  }

  // ─── FORCE PASSWORD RESET ────────────────────────────────────

  async forcePasswordReset(
    id: string,
    tenantId: string,
    actor: { id: string; role: UserRole },
    ipAddress?: string,
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id, tenantId },
      select: { id: true, email: true, role: true },
    });
    if (!target) throw new NotFoundException('User not found');

    if (id === actor.id) {
      throw new ForbiddenException(
        'Cannot force-reset your own password via this endpoint — use PATCH /auth/change-password',
      );
    }

    if (
      actor.role === UserRole.MANAGER &&
      !MANAGER_MANAGEABLE_ROLES.includes(target.role)
    ) {
      throw new ForbiddenException(
        `MANAGER cannot force a password reset for a ${target.role} account`,
      );
    }

    await this.prisma.user.update({
      where: { id },
      data: {
        mustChangePassword: true,
        refreshToken: null,
      },
    });

    await this.auditSafe({
      tenantId,
      actorId: actor.id,
      action: 'USER.FORCE_PASSWORD_RESET',
      entityType: 'User',
      entityId: id,
      metadata: {
        targetEmail: target.email,
        targetRole: target.role,
        requestedBy: actor.id,
        actorRole: actor.role,
        ipAddress,
      },
      ipAddress,
    });

    return {
      success: true,
      message:
        'Password reset forced. All existing sessions have been invalidated. ' +
        'The user must log in and set a new password before accessing any resources.',
    };
  }

  // ─── STALE ACCOUNT CLEANUP ───────────────────────────────────

  /**
   * Cron job that runs daily at 2:00 AM (EAT).
   * Finds and automatically deletes any PENDING accounts that were
   * created more than 30 days ago and have not been approved.
   */
  async generateTemporaryPassword(
    id: string,
    tenantId: string,
    actor: { id: string; role: UserRole },
    ipAddress?: string,
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id, tenantId },
      select: { id: true, email: true, firstName: true, lastName: true, role: true },
    });
    if (!target) throw new NotFoundException('User not found');

    if (id === actor.id) {
      throw new ForbiddenException(
        'Cannot generate a temporary password for your own account. Use PATCH /auth/change-password.',
      );
    }

    if (
      actor.role === UserRole.MANAGER &&
      !MANAGER_MANAGEABLE_ROLES.includes(target.role)
    ) {
      throw new ForbiddenException(
        `MANAGER cannot generate a temporary password for a ${target.role} account`,
      );
    }

    const temporaryPassword = this.generateTempPassword();
    const passwordHash = await argon2.hash(temporaryPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    await this.prisma.user.update({
      where: { id },
      data: {
        passwordHash,
        mustChangePassword: true,
        refreshToken: null,
      },
    });

    await this.auditSafe({
      tenantId,
      actorId: actor.id,
      action: 'USER.TEMPORARY_PASSWORD_GENERATED',
      entityType: 'User',
      entityId: id,
      metadata: {
        targetEmail: target.email,
        targetRole: target.role,
        requestedBy: actor.id,
        actorRole: actor.role,
        ipAddress,
      },
      ipAddress,
    });

    return {
      success: true,
      temporaryPassword,
      user: {
        id: target.id,
        email: target.email,
        firstName: target.firstName,
        lastName: target.lastName,
        role: target.role,
      },
      message:
        'Temporary password generated. This value is shown once and the user must change it on next login.',
    };
  }

  @Cron('0 2 * * *', { timeZone: 'Africa/Nairobi' })
  async cleanupStalePendingAccounts() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const twentyThreeDaysAgo = new Date();
    twentyThreeDaysAgo.setDate(twentyThreeDaysAgo.getDate() - 23);
    const twentyFourDaysAgo = new Date();
    twentyFourDaysAgo.setDate(twentyFourDaysAgo.getDate() - 24);

    // 1. Send warning emails to accounts exactly 23 days old (7 days until deletion)
    const warningUsers = await this.prisma.user.findMany({
      where: {
        accountStatus: AccountStatus.PENDING,
        createdAt: { gte: twentyFourDaysAgo, lt: twentyThreeDaysAgo },
      },
      select: { id: true, email: true, firstName: true },
    });

    for (const user of warningUsers) {
      this.enqueueEmail({
        type: 'ACCOUNT_DELETION_WARNING' as any, // Remember to add this to your EmailJobPayload type union
        to: user.email,
        firstName: user.firstName,
        saccoName: 'Beba SACCO',
      }, `users.deletion_warning:${user.id}`);
    }

    if (warningUsers.length > 0) {
      this.logger.log(`Sent deletion warnings to ${warningUsers.length} PENDING accounts.`);
    }

    // 2. Delete accounts older than 30 days
    const staleUsers = await this.prisma.user.findMany({
      where: {
        accountStatus: AccountStatus.PENDING,
        createdAt: { lt: thirtyDaysAgo },
      },
      select: { id: true, email: true, firstName: true, tenantId: true },
    });

    if (staleUsers.length === 0) return;

    this.logger.log(`Found ${staleUsers.length} stale PENDING accounts to delete.`);

    // Delete in bulk
    const result = await this.prisma.user.deleteMany({
      where: {
        id: { in: staleUsers.map((u) => u.id) },
      },
    });

    // Log audit events for each deleted user
    for (const user of staleUsers) {
      await this.auditSafe({
        tenantId: user.tenantId,
        actorId: 'SYSTEM',
        action: 'USER.DELETED_STALE',
        entityType: 'User',
        entityId: user.id,
        metadata: { email: user.email, reason: 'PENDING account older than 30 days automatically deleted' },
      });

      // Send final deletion notification
      this.enqueueEmail({
        type: 'ACCOUNT_DELETED' as any,
        to: user.email,
        firstName: user.firstName,
        saccoName: 'Beba SACCO',
      }, `users.deleted:${user.id}`);
    }

    this.logger.log(`Successfully deleted ${result.count} stale PENDING accounts.`);
  }

  // ─── PRIVATE HELPERS ─────────────────────────────────────────

  /** Fire-and-forget audit write — never let an audit failure break the user flow. */
  private async auditSafe(params: Parameters<AuditService['create']>[0]): Promise<void> {
    await this.audit
      .create(params)
      .catch((e: unknown) =>
        this.logger.error('Audit write failed (non-fatal)', e instanceof Error ? e.stack : e),
      );
  }

  private generateTempPassword(): string {
    const chars = [
      this.pickChar(TEMP_PASSWORD_UPPER),
      this.pickChar(TEMP_PASSWORD_LOWER),
      this.pickChar(TEMP_PASSWORD_DIGITS),
      this.pickChar(TEMP_PASSWORD_SYMBOLS),
    ];

    while (chars.length < 12) {
      chars.push(this.pickChar(TEMP_PASSWORD_ALL));
    }

    for (let i = chars.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }

    return chars.join('');
  }

  private pickChar(chars: string): string {
    return chars[randomInt(chars.length)];
  }
}
