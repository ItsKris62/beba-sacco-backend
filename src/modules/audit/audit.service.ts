import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

export interface CreateAuditLogDto {
  tenantId: string;
  actorId?: string;
  userId?: string; // deprecated alias for actorId (backward compat)
  action: string; // e.g. 'USER.CREATED', 'ROLE_CHANGED', 'STATUS_APPROVED'
  entityType?: string; // e.g. 'User', 'Loan'
  resource?: string; // deprecated alias for entityType (backward compat)
  entityId?: string;
  resourceId?: string; // deprecated alias for entityId (backward compat)
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

/**
 * Audit Service
 *
 * Append-only audit trail for SASRA compliance.
 * AuditLog records are NEVER updated or deleted.
 *
 * Called from:
 * - AuthService (auth events)
 * - AuditInterceptor (HTTP request/response metadata)
 * - UsersService (user lifecycle events)
 * - Future: domain services (loan events, transaction events)
 *
 * TODO: Phase 2 – async BullMQ queue for high-throughput scenarios (avoid blocking request)
 * TODO: Phase 3 – Tinybird integration for real-time analytics
 * TODO: Phase 3 – GDPR PII masking on metadata before storage
 * TODO: Phase 4 – export audit logs as signed CSV for regulatory submission
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist an audit event.
   * This is synchronous — call via fire-and-forget (.catch) from hot paths.
   */
  async create(dto: CreateAuditLogDto): Promise<void> {
    // Backward compat: resource/resourceId → entityType/entityId
    const entityType = dto.entityType ?? dto.resource ?? 'Unknown';
    const entityId = dto.entityId ?? dto.resourceId ?? null;
    const requestedActorId = dto.actorId ?? dto.userId ?? null;
    const actorId = requestedActorId === 'SYSTEM' ? null : requestedActorId;
    const metadata = {
      ...(dto.metadata ?? {}),
      ...(requestedActorId === 'SYSTEM' && { actorId: 'SYSTEM' }),
    };

    const prevEntry = await this.prisma.auditLog.findFirst({
      where: { tenantId: dto.tenantId },
      orderBy: { timestamp: 'desc' },
      select: { entryHash: true },
    });
    const prevHash = prevEntry?.entryHash ?? null;
    const timestamp = new Date();
    const payload = dto.payload ?? metadata;
    const entryHash = createHash('sha256')
      .update(JSON.stringify({ tenantId: dto.tenantId, actorId, action: dto.action, entityType, entityId, payload, prevHash, timestamp }), 'utf8')
      .digest('hex');

    await this.prisma.auditLog.create({
      data: {
        tenantId: dto.tenantId,
        actorId,
        action: dto.action,
        entityType,
        entityId,
        oldValue: dto.oldValue ? (dto.oldValue as Prisma.InputJsonValue) : Prisma.JsonNull,
        newValue: dto.newValue ? (dto.newValue as Prisma.InputJsonValue) : Prisma.JsonNull,
        metadata: metadata as Prisma.InputJsonValue,
        payload: payload as Prisma.InputJsonValue,
        ipAddress: dto.ipAddress ?? null,
        userAgent: dto.userAgent ?? null,
        requestId: dto.requestId ?? null,
        prevHash,
        entryHash,
        timestamp,
      },
    });
  }

  /**
   * Query audit logs with filters and pagination.
   */
  async findAll(filters: {
    tenantId: string;
    actorId?: string;
    action?: string;
    entityType?: string;
    fromDate?: Date;
    toDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ data: unknown[]; total: number }> {
    const safeLimit = Math.min(200, Math.max(1, filters.limit ?? 50));
    const safeOffset = Math.max(0, filters.offset ?? 0);

    const where: Prisma.AuditLogWhereInput = {
      tenantId: filters.tenantId,
      ...(filters.actorId && { actorId: filters.actorId }),
      ...(filters.action && { action: { contains: filters.action, mode: 'insensitive' } }),
      ...(filters.entityType && {
        entityType: { contains: filters.entityType, mode: 'insensitive' },
      }),
      ...((filters.fromDate || filters.toDate) && {
        timestamp: {
          ...(filters.fromDate && { gte: filters.fromDate }),
          ...(filters.toDate && { lte: filters.toDate }),
        },
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: safeOffset,
        take: safeLimit,
        include: {
          user: {
            select: { firstName: true, lastName: true, email: true },
          },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, total };
  }

  /**
   * Get all audit events for a specific resource instance.
   */
  async findByResource(entityType: string, entityId: string, tenantId: string) {
    return this.prisma.auditLog.findMany({
      where: { entityType, entityId, tenantId },
      orderBy: { timestamp: 'desc' },
      include: {
        user: {
          select: { firstName: true, lastName: true, email: true },
        },
      },
    });
  }
}
