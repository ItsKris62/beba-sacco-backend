import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { FeatureFlags } from '../../config/feature-flags';

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

export interface AuditLogFilters {
  tenantId?: string;
  actorId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  ipAddress?: string;
  userAgent?: string;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  offset?: number;
  crossTenant?: boolean;
}

export interface AuditLogEntry {
  id: string;
  tenantId: string;
  actorId: string | null;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  resource: string;
  resourceId: string | null;
  oldValue: Prisma.JsonValue | null;
  newValue: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
  payload: Prisma.JsonValue | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  prevHash: string | null;
  entryHash: string | null;
  timestamp: Date;
  user: { firstName: string; lastName: string; email: string } | null;
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
   * AuditLog rows are immutable at the database layer; Phase 2 migration
   * blocks UPDATE and DELETE with AUDIT_IMMUTABLE.
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
      featureFlags: {
        secureUpload: FeatureFlags.isEnabled('SECURE_UPLOAD_V2', dto.tenantId),
        rlsEnforcement: FeatureFlags.isEnabled('RLS_ENFORCEMENT', dto.tenantId),
        kycStatusAlias: FeatureFlags.isEnabled('KYC_STATUS_ALIAS', dto.tenantId),
      },
      ...(dto.requestId && { correlationId: dto.requestId }),
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
      .update(
        JSON.stringify({
          tenantId: dto.tenantId,
          actorId,
          action: dto.action,
          entityType,
          entityId,
          payload,
          prevHash,
          timestamp,
        }),
        'utf8',
      )
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

  async logAtomic(
    tx: Omit<Prisma.TransactionClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">,
    dto: CreateAuditLogDto,
  ): Promise<void> {
    const entityType = dto.entityType ?? dto.resource ?? 'Unknown';
    const entityId = dto.entityId ?? dto.resourceId ?? null;
    const requestedActorId = dto.actorId ?? dto.userId ?? null;
    const actorId = requestedActorId === 'SYSTEM' ? null : requestedActorId;
    const metadata = {
      ...(dto.metadata ?? {}),
      ...(requestedActorId === 'SYSTEM' && { actorId: 'SYSTEM' }),
      featureFlags: {
        secureUpload: FeatureFlags.isEnabled('SECURE_UPLOAD_V2', dto.tenantId),
        rlsEnforcement: FeatureFlags.isEnabled('RLS_ENFORCEMENT', dto.tenantId),
        kycStatusAlias: FeatureFlags.isEnabled('KYC_STATUS_ALIAS', dto.tenantId),
      },
      ...(dto.requestId && { correlationId: dto.requestId }),
    };

    const prevEntry = await tx.auditLog.findFirst({
      where: { tenantId: dto.tenantId },
      orderBy: { timestamp: 'desc' },
      select: { entryHash: true },
    });
    const prevHash = prevEntry?.entryHash ?? null;
    const timestamp = new Date();
    const payload = dto.payload ?? metadata;
    const entryHash = createHash('sha256')
      .update(
        JSON.stringify({
          tenantId: dto.tenantId,
          actorId,
          action: dto.action,
          entityType,
          entityId,
          payload,
          prevHash,
          timestamp,
        }),
        'utf8',
      )
      .digest('hex');

    await tx.auditLog.create({
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

  async createAtomic(
    tx: Omit<Prisma.TransactionClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">,
    dto: CreateAuditLogDto,
  ): Promise<void> {
    await this.logAtomic(tx, dto);
  }

  /**
   * Query audit logs with filters and pagination.
   */
  async findAll(filters: AuditLogFilters): Promise<{ data: AuditLogEntry[]; total: number }> {
    const safeLimit = Math.min(200, Math.max(1, filters.limit ?? 50));
    const safeOffset = Math.max(0, filters.offset ?? 0);

    const where = this.buildWhere(filters);
    const client = filters.crossTenant ? this.prisma.direct : this.prisma;

    const [data, total] = await client.$transaction([
      client.auditLog.findMany({
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
      client.auditLog.count({ where }),
    ]);

    return { data: data.map((entry) => this.serializeEntry(entry)), total };
  }

  async findForExport(filters: AuditLogFilters): Promise<AuditLogEntry[]> {
    const client = filters.crossTenant ? this.prisma.direct : this.prisma;
    const data = await client.auditLog.findMany({
      where: this.buildWhere(filters),
      orderBy: { timestamp: 'desc' },
      take: Math.min(5000, Math.max(1, filters.limit ?? 5000)),
      include: {
        user: {
          select: { firstName: true, lastName: true, email: true },
        },
      },
    });
    return data.map((entry) => this.serializeEntry(entry));
  }

  exportAsCsv(entries: AuditLogEntry[]): string {
    const headers = [
      'timestamp',
      'actor',
      'actorEmail',
      'action',
      'resource',
      'resourceId',
      'ipAddress',
      'requestId',
      'entryHash',
      'metadata',
    ];
    const rows = entries.map((entry) => [
      entry.timestamp.toISOString(),
      entry.user ? `${entry.user.firstName} ${entry.user.lastName}` : 'System',
      entry.user?.email ?? '',
      entry.action,
      entry.resource,
      entry.resourceId ?? '',
      entry.ipAddress ?? '',
      entry.requestId ?? '',
      entry.entryHash ?? '',
      JSON.stringify(entry.metadata ?? {}),
    ]);

    return [
      headers.join(','),
      ...rows.map((row) => row.map((value) => this.csvCell(value)).join(',')),
    ].join('\n');
  }

  async exportAsPdf(entries: AuditLogEntry[], title = 'Audit Trail Export'): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PDFDocument = require('pdfkit') as typeof import('pdfkit');

    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(16).fillColor('#111827').text(title, { align: 'center' });
      doc.moveDown(0.25);
      doc.fontSize(9).fillColor('#6b7280').text(`Generated: ${new Date().toISOString()}`, {
        align: 'center',
      });
      doc.moveDown();

      doc.fontSize(8).fillColor('#111827');
      entries.forEach((entry, index) => {
        if (doc.y > 735) doc.addPage();
        const actor = entry.user ? `${entry.user.firstName} ${entry.user.lastName}` : 'System';
        doc
          .font('Helvetica-Bold')
          .text(`${index + 1}. ${entry.timestamp.toISOString()} | ${entry.action}`, {
            continued: false,
          });
        doc
          .font('Helvetica')
          .text(
            `Actor: ${actor} | Resource: ${entry.resource}${entry.resourceId ? `/${entry.resourceId}` : ''}`,
          );
        doc.text(`IP: ${entry.ipAddress ?? '-'} | Request: ${entry.requestId ?? '-'}`);
        if (entry.entryHash) doc.text(`Hash: ${entry.entryHash}`);
        doc.moveDown(0.35);
      });

      if (entries.length === 0) {
        doc.text('No audit log entries matched the selected filters.');
      }

      doc.end();
    });
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

  private serializeEntry(
    entry: Prisma.AuditLogGetPayload<{
      include: { user: { select: { firstName: true; lastName: true; email: true } } };
    }>,
  ): AuditLogEntry {
    return {
      ...entry,
      userId: entry.actorId,
      resource: entry.entityType,
      resourceId: entry.entityId,
    };
  }

  private buildWhere(filters: AuditLogFilters): Prisma.AuditLogWhereInput {
    return {
      ...(filters.tenantId && { tenantId: filters.tenantId }),
      ...(filters.actorId && { actorId: filters.actorId }),
      ...(filters.action && { action: { contains: filters.action, mode: 'insensitive' } }),
      ...(filters.entityType && {
        entityType: { contains: filters.entityType, mode: 'insensitive' },
      }),
      ...(filters.entityId && { entityId: filters.entityId }),
      ...(filters.ipAddress && {
        ipAddress: { contains: filters.ipAddress, mode: 'insensitive' },
      }),
      ...(filters.userAgent && {
        userAgent: { contains: filters.userAgent, mode: 'insensitive' },
      }),
      ...((filters.fromDate || filters.toDate) && {
        timestamp: {
          ...(filters.fromDate && { gte: filters.fromDate }),
          ...(filters.toDate && { lte: filters.toDate }),
        },
      }),
    };
  }

  private csvCell(value: unknown): string {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
}
