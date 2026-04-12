import {
  Injectable, Logger, NotFoundException, ConflictException,
  ForbiddenException, BadRequestException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  lastLoginAt: true,
  emailVerified: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─── CREATE (admin channel) ──────────────────────────────────

  /**
   * Create a staff/member account with a temporary password.
   * mustChangePassword is set to true — the user must change on first login.
   * SUPER_ADMIN cannot be created through this endpoint.
   */
  async create(dto: CreateUserDto, tenantId: string, createdBy: string, ipAddress?: string) {
    if (dto.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('SUPER_ADMIN cannot be assigned via this endpoint');
    }

    const existing = await this.prisma.user.findUnique({
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
        mustChangePassword: true,
      },
      select: USER_SELECT,
    });

    await this.audit.create({
      tenantId,
      userId: createdBy,
      action: 'USER.CREATE',
      resource: 'User',
      resourceId: user.id,
      metadata: { email: user.email, role: user.role, createdForTenant: tenantId },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    return user;
  }

  // ─── LIST ────────────────────────────────────────────────────

  async findAll(
    tenantId: string,
    opts: { page?: number; limit?: number; search?: string; role?: UserRole } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = {
      tenantId,
      ...(opts.role && { role: opts.role }),
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

  async update(id: string, dto: UpdateUserDto, tenantId: string, updatedBy: string, ipAddress?: string) {
    const user = await this.prisma.user.findFirst({ where: { id, tenantId }, select: { id: true, role: true } });
    if (!user) throw new NotFoundException('User not found');

    // Prevent elevating to SUPER_ADMIN
    if (dto.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('SUPER_ADMIN cannot be assigned via this endpoint');
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

    await this.audit.create({
      tenantId,
      userId: updatedBy,
      action: 'USER.UPDATE',
      resource: 'User',
      resourceId: id,
      metadata: { changes: dto },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    return updated;
  }

  // ─── DEACTIVATE ──────────────────────────────────────────────

  async deactivate(id: string, tenantId: string, deactivatedBy: string, ipAddress?: string) {
    const user = await this.prisma.user.findFirst({ where: { id, tenantId }, select: { id: true, isActive: true } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.isActive) throw new BadRequestException('User is already inactive');

    // Prevent self-deactivation
    if (id === deactivatedBy) throw new ForbiddenException('Cannot deactivate your own account');

    const updated = await this.prisma.user.update({
      where: { id },
      data: { isActive: false, refreshToken: null },
      select: USER_SELECT,
    });

    await this.audit.create({
      tenantId,
      userId: deactivatedBy,
      action: 'USER.DEACTIVATE',
      resource: 'User',
      resourceId: id,
      metadata: {},
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    return updated;
  }

  // ─── FORCE PASSWORD RESET ────────────────────────────────────

  async forcePasswordReset(id: string, tenantId: string, requestedBy: string, ipAddress?: string) {
    const user = await this.prisma.user.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!user) throw new NotFoundException('User not found');

    await this.prisma.user.update({
      where: { id },
      data: { mustChangePassword: true, refreshToken: null },
    });

    await this.audit.create({
      tenantId,
      userId: requestedBy,
      action: 'USER.FORCE_PASSWORD_RESET',
      resource: 'User',
      resourceId: id,
      metadata: { requestedBy },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    return { message: 'Password reset forced. User will be required to set a new password on next login.' };
  }
}
