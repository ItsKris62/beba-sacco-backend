import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as Sentry from '@sentry/nestjs';
import { randomInt } from 'crypto';
import * as argon2 from 'argon2';
import { UserRole, AccountStatus, PinPurpose } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { canCreateUserWithRole, canManageRole } from '../../common/guards/rbac.guard';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { QUEUE_NAMES, EmailJobPayload } from '../queue/queue.constants';
import { PinService } from '../pin/pin.service';
import { SmsService } from '../sms/sms.service';
import { EncryptionService, EncryptedPayload } from '../zero-trust/encryption/encryption.service';

const TEMP_PASSWORD_UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const TEMP_PASSWORD_LOWER = 'abcdefghjkmnpqrstuvwxyz';
const TEMP_PASSWORD_DIGITS = '23456789';
const TEMP_PASSWORD_SYMBOLS = '@#$!';
const TEMP_PASSWORD_ALL =
  TEMP_PASSWORD_UPPER + TEMP_PASSWORD_LOWER + TEMP_PASSWORD_DIGITS + TEMP_PASSWORD_SYMBOLS;
const TEMP_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;

const USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
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
    private readonly pinService: PinService,
    private readonly smsService: SmsService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue<EmailJobPayload>,
  ) {}

  private enqueueEmail(payload: EmailJobPayload, ctx: string): void {
    this.emailQueue
      .add('send', payload, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } })
      .catch((e: unknown) =>
        this.logger.error(
          `[EmailQueue] enqueue failed [${ctx}]: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  }

  /**
   * Awaited variant of enqueueEmail â€” used where the caller needs to know
   * (and report back, e.g. `emailEnqueued` in the create() response) whether
   * the job was actually queued, mirroring SmsService.enqueueSms's contract.
   */
  private async enqueueEmailAwaited(payload: EmailJobPayload, ctx: string): Promise<boolean> {
    try {
      await this.emailQueue.add('send', payload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });
      return true;
    } catch (e: unknown) {
      this.logger.error(
        `[EmailQueue] enqueue failed [${ctx}]: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  private createTempPasswordExpiry(): Date {
    return new Date(Date.now() + TEMP_PASSWORD_TTL_MS);
  }

  // â”€â”€â”€ CREATE (admin channel) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Create a staff account. No password is ever typed by the admin.
   * A 24-hour temporary password is generated server-side, sent to the staff
   * member by email, and stored only as an Argon2id hash plus an encrypted
   * recovery blob until the staff member changes it.
   *
   * The user logs in with the temp password and is forced to set a permanent
   * password before accessing protected resources. No SMS PIN or login OTP is
   * required for this staff onboarding path.
   *
   * Role restrictions:
   *   - SUPER_ADMIN cannot be assigned via this endpoint (platform-only role)
   *   - MEMBER/CHAIRMAN cannot be assigned via this endpoint (would create a User
   *     with no linked Member profile â€” use POST /members instead)
   *   - MANAGER cannot create TENANT_ADMIN accounts (role hierarchy)
   *   - TENANT_ADMIN can create any tenant-level role
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

    // Belt-and-suspenders alongside the DTO's STAFF_ASSIGNABLE_ROLES whitelist â€”
    // a User created here never gets a linked Member row, so MEMBER/CHAIRMAN
    // accounts created through this endpoint would be orphaned.
    if (dto.role === UserRole.MEMBER || dto.role === UserRole.CHAIRMAN) {
      throw new BadRequestException(
        'Members and Chairmen must be created via the Members Management flow, not the Staff Users endpoint.',
      );
    }

    // Role hierarchy enforcement â€” DTO validation only confirms dto.role is an
    // assignable role in general; it does not know the actor. That check happens here.
    if (!canCreateUserWithRole(actor.role, dto.role)) {
      throw new ForbiddenException(`${actor.role} cannot create accounts with role ${dto.role}`);
    }

    const existing = await this.prisma.user.findFirst({
      where: { email: dto.email.toLowerCase() },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Email already registered');

    const temporaryPassword = this.generateTempPassword();
    const passwordHash = await argon2.hash(temporaryPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
    const encryptedPayload = await this.encryption.encrypt(temporaryPassword, tenantId);
    const tempPasswordEncrypted = JSON.stringify(encryptedPayload);
    const tempPasswordExpiresAt = this.createTempPasswordExpiry();

    const user = await this.prisma.user.create({
      data: {
        tenantId,
        email: dto.email.toLowerCase(),
        passwordHash,
        tempPasswordEncrypted,
        tempPasswordExpiresAt,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone || null,
        role: dto.role,
        accountStatus: AccountStatus.ACTIVE,
        mustChangePassword: true,
        emailVerified: true,
        phoneVerified: true,
        createdById: actor.id,
      },
      select: USER_SELECT,
    });

    // The plaintext never enters the Redis-backed email payload, only the encrypted
    // blob plus tenant scope. If queueing fails, a tenant admin can use the reveal
    // fallback before the one-day expiry.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    const appUrl = this.config.get<string>('app.appUrl') ?? 'http://localhost:3000';
    const emailEnqueued = await this.enqueueEmailAwaited(
      {
        type: 'STAFF_ACCOUNT_CREATED',
        to: user.email,
        firstName: user.firstName,
        saccoName: tenant?.name ?? 'Beba SACCO',
        role: user.role,
        portalUrl: `${appUrl}/login`,
        expiresAt: tempPasswordExpiresAt.toISOString(),
        purpose: 'ACCOUNT_CREATED',
        encryptedPayload: tempPasswordEncrypted,
        tenantId,
      },
      `users.create.email:${user.id}`,
    );

    await this.auditSafe({
      tenantId,
      actorId: actor.id,
      action: 'USER.CREATED',
      entityType: 'User',
      entityId: user.id,
      newValue: {
        email: user.email,
        role: user.role,
        accountStatus: user.accountStatus,
        createdById: actor.id,
      },
      metadata: {
        ipAddress,
        emailEnqueued,
        tempPasswordExpiresAt: tempPasswordExpiresAt.toISOString(),
      },
      ipAddress,
    });

    return {
      success: true,
      message: emailEnqueued
        ? 'User created. Temporary password sent via email.'
        : 'User created, but email enqueue failed. A tenant admin can retrieve it via GET /users/:id/reveal-temp-password.',
      emailEnqueued,
      tempPasswordExpiresAt,
      user,
    };
  }

  // â”€â”€â”€ LIST â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async findAll(
    tenantId: string,
    opts: {
      page?: number;
      limit?: number;
      search?: string;
      role?: UserRole;
      accountStatus?: AccountStatus;
    } = {},
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

  // â”€â”€â”€ FIND ONE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€â”€ UPDATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

    // Actor must be permitted to manage the target's current role...
    if (!canManageRole(actor.role, target.role)) {
      throw new ForbiddenException(`${actor.role} cannot modify a ${target.role} account`);
    }

    // ...and, if reassigning, permitted to assign the new role too
    if (dto.role !== undefined && !canManageRole(actor.role, dto.role)) {
      throw new ForbiddenException(`${actor.role} cannot assign role ${dto.role}`);
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

  // â”€â”€â”€ UPDATE STATUS (Approval Workflow) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Explicit approval state machine.
   *
   * Valid transitions:
   *   PENDING   â†’ APPROVED
   *   PENDING   â†’ REJECTED
   *   APPROVED  â†’ SUSPENDED
   *   SUSPENDED â†’ APPROVED
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
        `Invalid status transition: ${target.accountStatus} â†’ ${dto.status}. Allowed: [${allowed.join(', ')}]`,
      );
    }

    // Idempotency check
    // TODO(incident 2026-07-20): unlike loan-application.service.ts's
    // memberApply(), the work below isn't wrapped in a try/catch at all — if
    // prisma.user.update() or the audit write throws, the reserved key stays
    // PROCESSING for its full 3600s TTL with no release path whatsoever. Same
    // failure class as the loan-apply incident, worse (no release at all
    // rather than a narrow release condition). Not fixed here — out of scope
    // for this incident's PR, unrelated module — flagged per the postmortem's
    // action item to audit other idempotency-key acquisitions.
    if (dto.idempotencyKey) {
      const idem = await this.idempotency.checkAndReserve(dto.idempotencyKey, tenantId, 3600);
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
      newValue: {
        accountStatus: updated.accountStatus,
        approvedById: actor.id,
        approvedAt: updated.approvedAt,
        reason: dto.reason,
      },
      metadata: { ipAddress, actorRole: actor.role },
      ipAddress,
    });

    const result = { success: true, user: updated };

    if (dto.idempotencyKey) {
      await this.idempotency.complete(dto.idempotencyKey, tenantId, result, 3600);
    }

    return result;
  }

  // â”€â”€â”€ DEACTIVATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    if (target.accountStatus !== AccountStatus.ACTIVE)
      throw new BadRequestException('User is not active');

    if (id === actor.id) {
      throw new ForbiddenException('Cannot deactivate your own account');
    }

    if (!canManageRole(actor.role, target.role)) {
      throw new ForbiddenException(`${actor.role} cannot deactivate a ${target.role} account`);
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

  // â”€â”€â”€ FORCE PASSWORD RESET â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
        'Cannot force-reset your own password via this endpoint â€” use PATCH /auth/change-password',
      );
    }

    if (!canManageRole(actor.role, target.role)) {
      throw new ForbiddenException(
        `${actor.role} cannot force a password reset for a ${target.role} account`,
      );
    }

    await this.prisma.user.update({
      where: { id },
      data: {
        mustChangePassword: true,
        lastPasswordChangeAt: new Date(),
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

  // â”€â”€â”€ ADMIN "REVEAL PIN" FALLBACK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Admin fallback for "view and share the PIN directly" (e.g. SMS delivery
   * failed). Never returns a previously-issued PIN â€” always revokes it and
   * issues + sends a brand new one, so no plaintext PIN is ever retained at rest.
   */
  async revealPin(
    id: string,
    tenantId: string,
    actor: { id: string; role: UserRole },
    ipAddress?: string,
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id, tenantId },
      select: { id: true, role: true, pinLoginRequired: true },
    });
    if (!target) throw new NotFoundException('User not found');

    if (!target.pinLoginRequired) {
      throw new BadRequestException(
        'User has already completed PIN onboarding. Use force-password-reset instead.',
      );
    }

    if (!canManageRole(actor.role, target.role)) {
      throw new ForbiddenException(
        `${actor.role} cannot reveal a PIN for a ${target.role} account`,
      );
    }

    // Reveal always triggers a fresh SMS (Option B) â€” same abuse cap as resend-pin.
    await this.pinService.assertIssuanceRateLimit(`reveal-pin:admin:${actor.id}`, 5, 3600);

    const issued = await this.pinService.regenerateAndRevealPin(
      target.id,
      tenantId,
      actor.id,
      PinPurpose.FIRST_LOGIN,
      ipAddress,
    );

    return { pin: issued.pin, expiresAt: issued.expiresAt };
  }

  // â”€â”€â”€ RESEND PIN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Regenerate and re-send the first-login PIN (e.g. the original SMS never
   * arrived or the PIN expired). Does not reveal the PIN to the caller.
   */
  async resendPin(
    id: string,
    tenantId: string,
    actor: { id: string; role: UserRole },
    ipAddress?: string,
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id, tenantId },
      select: { id: true, role: true, pinLoginRequired: true },
    });
    if (!target) throw new NotFoundException('User not found');

    if (!target.pinLoginRequired) {
      throw new BadRequestException(
        'User has already completed PIN onboarding. Use force-password-reset instead.',
      );
    }

    if (!canManageRole(actor.role, target.role)) {
      throw new ForbiddenException(
        `${actor.role} cannot resend a PIN for a ${target.role} account`,
      );
    }

    // SMS costs money â€” cap regardless of how many different users this admin targets.
    await this.pinService.assertIssuanceRateLimit(`resend-pin:admin:${actor.id}`, 5, 3600);

    const issued = await this.pinService.generateAndIssuePin(
      target.id,
      tenantId,
      PinPurpose.FIRST_LOGIN,
      ipAddress,
    );

    await this.auditSafe({
      tenantId,
      actorId: actor.id,
      action: 'USER.PIN_RESENT',
      entityType: 'User',
      entityId: target.id,
      metadata: { expiresAt: issued.expiresAt, ipAddress },
      ipAddress,
    });

    return { success: true, message: 'New PIN sent.' };
  }

  // â”€â”€â”€ STALE ACCOUNT CLEANUP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        phone: true,
        phoneNumber: true,
      },
    });
    if (!target) throw new NotFoundException('User not found');

    if (id === actor.id) {
      throw new ForbiddenException(
        'Cannot generate a temporary password for your own account. Use PATCH /auth/change-password.',
      );
    }

    if (!canManageRole(actor.role, target.role)) {
      throw new ForbiddenException(
        `${actor.role} cannot generate a temporary password for a ${target.role} account`,
      );
    }

    const temporaryPassword = this.generateTempPassword();
    const passwordHash = await argon2.hash(temporaryPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
    const encryptedPayload = await this.encryption.encrypt(temporaryPassword, tenantId);
    const tempPasswordEncrypted = JSON.stringify(encryptedPayload);
    const tempPasswordExpiresAt = this.createTempPasswordExpiry();

    await this.prisma.user.update({
      where: { id },
      data: {
        passwordHash,
        tempPasswordEncrypted,
        tempPasswordExpiresAt,
        mustChangePassword: true,
        phoneVerified: true,
        lastPasswordChangeAt: new Date(),
        refreshToken: null,
      },
    });

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    const appUrl = this.config.get<string>('app.appUrl') ?? 'http://localhost:3000';
    const emailEnqueued = await this.enqueueEmailAwaited(
      {
        type: 'STAFF_ACCOUNT_CREATED',
        to: target.email,
        firstName: target.firstName,
        saccoName: tenant?.name ?? 'Beba SACCO',
        role: target.role,
        portalUrl: `${appUrl}/login`,
        expiresAt: tempPasswordExpiresAt.toISOString(),
        purpose: 'TEMP_PASSWORD_REGENERATED',
        encryptedPayload: tempPasswordEncrypted,
        tenantId,
      },
      `users.temp_password.email:${id}`,
    );
    if (emailEnqueued === false) {
      this.logger.warn(`Temp password generated for user=${id} but email queueing failed`);
    }

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
        emailEnqueued,
        tempPasswordExpiresAt: tempPasswordExpiresAt.toISOString(),
        ipAddress,
      },
      ipAddress,
    });

    return {
      success: true,
      emailEnqueued,
      tempPasswordExpiresAt,
      user: {
        id: target.id,
        email: target.email,
        firstName: target.firstName,
        lastName: target.lastName,
        role: target.role,
      },
      message: emailEnqueued
        ? 'Temporary password generated and sent via email.'
        : 'Temporary password generated, but email enqueue failed. Retrieve it via GET /users/:id/reveal-temp-password.',
    };
  }

  // â”€â”€â”€ ADMIN "REVEAL TEMP PASSWORD" FALLBACK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Admin fallback to retrieve the current temporary password when email delivery
   * failed (or the original message was lost). Decrypts the AES-256-GCM blob stored
   * alongside the Argon2id hash - the plaintext is never persisted anywhere else.
   * Once the staff user sets their own password (PATCH /auth/change-password),
   * tempPasswordEncrypted is cleared and this endpoint stops working for that account.
   */
  async revealTemporaryPassword(
    id: string,
    tenantId: string,
    actor: { id: string; role: UserRole },
    ipAddress?: string,
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id, tenantId },
      select: { id: true, role: true, tempPasswordEncrypted: true, tempPasswordExpiresAt: true },
    });
    if (!target) throw new NotFoundException('User not found');

    if (!target.tempPasswordEncrypted) {
      throw new BadRequestException(
        'This user has already set their own password. No temporary password is available to reveal.',
      );
    }

    if (target.tempPasswordExpiresAt && target.tempPasswordExpiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(
        'This temporary password has expired. Generate a new temporary password for this user.',
      );
    }

    if (!canManageRole(actor.role, target.role)) {
      throw new ForbiddenException(
        `${actor.role} cannot reveal a temporary password for a ${target.role} account`,
      );
    }

    // Same abuse cap as reveal-pin - this is a plaintext
    // credential disclosure endpoint and should be rate-limited accordingly.
    await this.pinService.assertIssuanceRateLimit(
      `reveal-temp-password:admin:${actor.id}`,
      5,
      3600,
    );

    const payload = JSON.parse(target.tempPasswordEncrypted) as EncryptedPayload;
    const temporaryPassword = await this.encryption.decrypt(payload, tenantId);

    await this.auditSafe({
      tenantId,
      actorId: actor.id,
      action: 'USER.TEMPORARY_PASSWORD_REVEALED',
      entityType: 'User',
      entityId: target.id,
      metadata: { ipAddress },
      ipAddress,
    });

    return { temporaryPassword };
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
      this.enqueueEmail(
        {
          type: 'ACCOUNT_DELETION_WARNING' as any, // Remember to add this to your EmailJobPayload type union
          to: user.email,
          firstName: user.firstName,
          saccoName: 'Beba SACCO',
        },
        `users.deletion_warning:${user.id}`,
      );
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
        metadata: {
          email: user.email,
          reason: 'PENDING account older than 30 days automatically deleted',
        },
      });

      // Send final deletion notification
      this.enqueueEmail(
        {
          type: 'ACCOUNT_DELETED' as any,
          to: user.email,
          firstName: user.firstName,
          saccoName: 'Beba SACCO',
        },
        `users.deleted:${user.id}`,
      );
    }

    this.logger.log(`Successfully deleted ${result.count} stale PENDING accounts.`);
  }

  // â”€â”€â”€ PRIVATE HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async disableUser2fa(
    userId: string,
    tenantId: string,
    actor: { id: string },
    ipAddress?: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId, tenantId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if ((tenant?.settings as any)?.security?.require2FA === true) {
      throw new ForbiddenException('Tenant policy requires 2FA. You cannot disable it.');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        totpSecret: null,
        backupCodes: [],
        totpEnrolledAt: null,
      },
    });

    await this.auditSafe({
      tenantId,
      userId: actor.id,
      action: 'ADMIN.USER.2FA_DISABLED',
      resource: 'User',
      resourceId: userId,
      ipAddress,
    });

    return { success: true, message: '2FA has been disabled for this user' };
  }

  /**
   * Fire-and-forget audit write â€” never let an audit failure break the user flow.
   * A dropped entry here breaks the tamper-evident hash chain (SASRA compliance),
   * so beyond the local log line it's also reported to Sentry â€” a silent gap in
   * the chain should never be discoverable only by grepping server logs.
   */
  private async auditSafe(params: Parameters<AuditService['create']>[0]): Promise<void> {
    await this.audit.create(params).catch((e: unknown) => {
      this.logger.error('Audit write failed (non-fatal)', e instanceof Error ? e.stack : e);
      Sentry.captureException(e, { tags: { audit_chain_broken: true, action: params.action } });
    });
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
