import {
  Injectable, Logger, NotFoundException, ConflictException,
  ForbiddenException, BadRequestException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { UserRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { IdempotencyService } from '../../common/services/idempotency.service';

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

const USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  role: true,
  status: true,
  isActive: true,
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
  ) {}

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
        status: UserStatus.PENDING,
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
      newValue: { email: user.email, role: user.role, status: user.status, createdById: actor.id },
      metadata: { ipAddress },
      ipAddress,
    });

    return user;
  }

  // ─── LIST ────────────────────────────────────────────────────

  async findAll(
    tenantId: string,
    opts: { page?: number; limit?: number; search?: string; role?: UserRole; status?: UserStatus } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = {
      tenantId,
      ...(opts.role && { role: opts.role }),
      ...(opts.status && { status: opts.status }),
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
      select: { id: true, role: true, status: true, email: true },
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
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
      select: USER_SELECT,
    });

    await this.auditSafe({
      tenantId,
      actorId: actor.id,
      action: dto.role !== undefined ? 'ROLE_CHANGED' : 'USER.UPDATED',
      entityType: 'User',
      entityId: id,
      oldValue: { role: target.role, isActive: true /* approximate */ },
      newValue: { role: updated.role, isActive: updated.isActive },
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
      select: { id: true, status: true, email: true, role: true },
    });
    if (!target) throw new NotFoundException('User not found');

    const validTransitions: Record<UserStatus, UserStatus[]> = {
      [UserStatus.PENDING]: [UserStatus.APPROVED, UserStatus.REJECTED],
      [UserStatus.APPROVED]: [UserStatus.SUSPENDED],
      [UserStatus.REJECTED]: [],
      [UserStatus.SUSPENDED]: [UserStatus.APPROVED],
    };

    const allowed = validTransitions[target.status];
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException(
        `Invalid status transition: ${target.status} → ${dto.status}. Allowed: [${allowed.join(', ')}]`,
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

    const oldStatus = target.status;
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        status: dto.status,
        approvedById: actor.id,
        approvedAt: new Date(),
        approvalReason: dto.reason ?? null,
        // Auto-activate on approval, deactivate on rejection/suspension
        isActive: dto.status === UserStatus.APPROVED,
      },
      select: USER_SELECT,
    });

    await this.auditSafe({
      tenantId,
      actorId: actor.id,
      action: 'STATUS_CHANGED',
      entityType: 'User',
      entityId: id,
      oldValue: { status: oldStatus },
      newValue: { status: updated.status, approvedById: actor.id, approvedAt: updated.approvedAt, reason: dto.reason },
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
      select: { id: true, isActive: true, role: true, status: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (!target.isActive) throw new BadRequestException('User is already inactive');

    if (id === actor.id) {
      throw new ForbiddenException('Cannot deactivate your own account');
    }

    // MANAGER cannot deactivate a TENANT_ADMIN
    if (actor.role === UserRole.MANAGER && target.role === UserRole.TENANT_ADMIN) {
      throw new ForbiddenException('MANAGER cannot deactivate a TENANT_ADMIN account');
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { isActive: false, refreshToken: null },
      select: USER_SELECT,
    });

    await this.auditSafe({
      tenantId,
      actorId: actor.id,
      action: 'USER.DEACTIVATED',
      entityType: 'User',
      entityId: id,
      oldValue: { isActive: true },
      newValue: { isActive: false },
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

  // ─── PRIVATE HELPERS ─────────────────────────────────────────

  /** Fire-and-forget audit write — never let an audit failure break the user flow. */
  private async auditSafe(params: Parameters<AuditService['create']>[0]): Promise<void> {
    await this.audit
      .create(params)
      .catch((e: unknown) =>
        this.logger.error('Audit write failed (non-fatal)', e instanceof Error ? e.stack : e),
      );
  }
}
