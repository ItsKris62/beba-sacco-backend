/**
 * Phase 7 – Data Lineage Tracking Service
 * Logs entity, field, accessorId, purpose, timestamp for all PII reads/exports.
 * Stored in DataAccessLog table. Full access trail for DPA compliance.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

export interface LineageEntry {
  tenantId: string;
  entity: string;
  entityId: string;
  field?: string;
  accessorId: string;
  accessorRole: string;
  purpose: string;
  action: 'READ' | 'EXPORT' | 'MODIFY' | 'DELETE';
  ipAddress?: string;
  requestId?: string;
}

export interface LineageQueryParams {
  tenantId: string;
  entity?: string;
  field?: string;
  from?: string;
  to?: string;
  accessorId?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class LineageService {
  private readonly logger = new Logger(LineageService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a PII access event in the DataAccessLog table.
   */
  async record(entry: LineageEntry): Promise<void> {
    try {
      await this.prisma.dataAccessLog.create({
        data: {
          tenantId: entry.tenantId,
          entity: entry.entity,
          entityId: entry.entityId,
          field: entry.field,
          accessorId: entry.accessorId,
          accessorRole: entry.accessorRole,
          purpose: entry.purpose,
          action: entry.action,
          ipAddress: entry.ipAddress,
          requestId: entry.requestId,
          timestamp: new Date(),
        },
      });
    } catch (err) {
      this.logger.error(`[Lineage] Failed to record access: ${(err as Error).message}`);
    }
  }

  /**
   * Query the full PII access trail for a given entity/field/time range.
   */
  async query(params: LineageQueryParams): Promise<{
    records: unknown[];
    total: number;
    hasMore: boolean;
  }> {
    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;

    const where: Record<string, unknown> = { tenantId: params.tenantId };
    if (params.entity) where['entity'] = params.entity;
    if (params.field) where['field'] = params.field;
    if (params.accessorId) where['accessorId'] = params.accessorId;
    if (params.from || params.to) {
      where['timestamp'] = {
        ...(params.from ? { gte: new Date(params.from) } : {}),
        ...(params.to ? { lte: new Date(params.to) } : {}),
      };
    }

    const [records, total] = await Promise.all([
      this.prisma.dataAccessLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.dataAccessLog.count({ where }),
    ]);

    return { records, total, hasMore: offset + limit < total };
  }

  /**
   * Get consent proofs for a member (for DPA audit export).
   */
  async getConsentProofs(tenantId: string, memberId: string): Promise<unknown[]> {
    return this.prisma.consentRegistry.findMany({
      where: { tenantId, memberId },
      orderBy: { timestamp: 'desc' },
    });
  }

  /**
   * Generate a lineage summary for a member (used in erasure certificates).
   */
  async getMemberLineageSummary(tenantId: string, memberId: string): Promise<{
    totalAccesses: number;
    uniqueAccessors: number;
    purposes: string[];
    lastAccessed: Date | null;
  }> {
    const logs = await this.prisma.dataAccessLog.findMany({
      where: { tenantId, entityId: memberId },
    });

    const uniqueAccessors = new Set(logs.map((l) => l.accessorId)).size;
    const purposes = [...new Set(logs.map((l) => l.purpose))];
    const lastAccessed = logs.length > 0
      ? logs.reduce((max, l) => (l.timestamp > max ? l.timestamp : max), logs[0].timestamp)
      : null;

    return {
      totalAccesses: logs.length,
      uniqueAccessors,
      purposes,
      lastAccessed,
    };
  }
}
