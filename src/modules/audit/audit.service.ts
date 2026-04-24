import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface CreateAuditLogDto {
  tenantId: string;
  userId?: string;
  action: string;      // e.g. 'AUTH.LOGIN', 'LOAN.CREATE'
  resource: string;    // e.g. 'User', 'Loan'
  resourceId?: string;
  metadata?: Record<string, unknown>;
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
    await this.prisma.auditLog.create({
      data: {
        tenantId: dto.tenantId,
        userId: dto.userId ?? null,
        action: dto.action,
        resource: dto.resource,
        resourceId: dto.resourceId ?? null,
        metadata: (dto.metadata ?? {}) as Prisma.InputJsonValue,
        ipAddress: dto.ipAddress ?? null,
        userAgent: dto.userAgent ?? null,
        requestId: dto.requestId ?? null,
      },
    });
  }

  /**
   * Query audit logs with basic filters and pagination.
   */
  async findAll(filters: {
    tenantId: string;
    userId?: string;
    action?: string;
    fromDate?: Date;
    toDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ data: unknown[]; total: number }> {
    const safeLimit = filters.limit ?? 50;
    const safeOffset = filters.offset ?? 0;

    const where: Prisma.AuditLogWhereInput = {
      tenantId: filters.tenantId,
      ...(filters.userId && { userId: filters.userId }),
      ...(filters.action && { action: { contains: filters.action, mode: 'insensitive' } }),
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
   * TODO: Phase 3 – implement
   */
  async findByResource(_resource: string, _resourceId: string) {
    // TODO: Phase 3 – implement
    throw new Error('Not implemented – Phase 3');
  }
}
