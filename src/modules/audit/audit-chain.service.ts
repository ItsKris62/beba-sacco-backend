import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditChainVerifyResult {
  tenantId: string;
  valid: boolean;
  totalEntries: number;
  verifiedEntries: number;
  tamperEvidence: TamperEvidence[];
  verifiedAt: string;
}

export interface TamperEvidence {
  auditLogId: string;
  timestamp: string;
  action: string;
  issue: 'HASH_MISMATCH' | 'MISSING_HASH' | 'BROKEN_CHAIN';
  expectedHash?: string;
  actualHash?: string;
}

/**
 * Audit Chain Service – Phase 6
 *
 * Implements cryptographic audit chain verification.
 * Each AuditLog entry stores:
 *  - entryHash: SHA-256(tenantId + userId + action + resource + resourceId + timestamp + prevHash)
 *  - prevHash:  entryHash of the previous entry in the chain
 *
 * GET /admin/audit/verify-chain walks the chain and returns tamper evidence.
 */
@Injectable()
export class AuditChainService {
  private readonly logger = new Logger(AuditChainService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Compute the SHA-256 hash for an audit log entry.
   */
  computeEntryHash(entry: {
    tenantId: string;
    userId?: string | null;
    action: string;
    resource: string;
    resourceId?: string | null;
    timestamp: Date;
    prevHash?: string | null;
  }): string {
    const payload = [
      entry.tenantId,
      entry.userId ?? '',
      entry.action,
      entry.resource,
      entry.resourceId ?? '',
      entry.timestamp.toISOString(),
      entry.prevHash ?? '',
    ].join('|');

    return createHash('sha256').update(payload, 'utf8').digest('hex');
  }

  /**
   * Verify the audit chain for a tenant.
   * Walks entries in chronological order, recomputes each hash,
   * and checks prevHash linkage.
   */
  async verifyChain(tenantId: string, limit = 10000): Promise<AuditChainVerifyResult> {
    const entries = await this.prisma.auditLog.findMany({
      where: { tenantId },
      orderBy: { timestamp: 'asc' },
      take: limit,
      select: {
        id: true,
        tenantId: true,
        userId: true,
        action: true,
        resource: true,
        resourceId: true,
        timestamp: true,
        prevHash: true,
        entryHash: true,
      },
    });

    const tamperEvidence: TamperEvidence[] = [];
    let prevHash: string | null = null;

    for (const entry of entries) {
      // Check if entry has a hash
      if (!entry.entryHash) {
        tamperEvidence.push({
          auditLogId: entry.id,
          timestamp: entry.timestamp.toISOString(),
          action: entry.action,
          issue: 'MISSING_HASH',
        });
        prevHash = null;
        continue;
      }

      // Check prevHash linkage
      if (prevHash !== null && entry.prevHash !== prevHash) {
        tamperEvidence.push({
          auditLogId: entry.id,
          timestamp: entry.timestamp.toISOString(),
          action: entry.action,
          issue: 'BROKEN_CHAIN',
          expectedHash: prevHash,
          actualHash: entry.prevHash ?? undefined,
        });
      }

      // Recompute hash and verify
      const expectedHash = this.computeEntryHash({
        tenantId: entry.tenantId,
        userId: entry.userId,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId,
        timestamp: entry.timestamp,
        prevHash: entry.prevHash,
      });

      if (expectedHash !== entry.entryHash) {
        tamperEvidence.push({
          auditLogId: entry.id,
          timestamp: entry.timestamp.toISOString(),
          action: entry.action,
          issue: 'HASH_MISMATCH',
          expectedHash,
          actualHash: entry.entryHash,
        });
      }

      prevHash = entry.entryHash;
    }

    const result: AuditChainVerifyResult = {
      tenantId,
      valid: tamperEvidence.length === 0,
      totalEntries: entries.length,
      verifiedEntries: entries.length - tamperEvidence.length,
      tamperEvidence,
      verifiedAt: new Date().toISOString(),
    };

    this.logger.log(
      `Audit chain verification for tenant ${tenantId}: ${result.valid ? 'VALID' : 'TAMPERED'} ` +
      `(${entries.length} entries, ${tamperEvidence.length} issues)`,
    );

    return result;
  }

  /**
   * Stamp a new audit log entry with its hash.
   * Called by AuditService when creating new entries.
   */
  async stampEntry(auditLogId: string): Promise<void> {
    const entry = await this.prisma.auditLog.findUnique({
      where: { id: auditLogId },
      select: {
        id: true,
        tenantId: true,
        userId: true,
        action: true,
        resource: true,
        resourceId: true,
        timestamp: true,
      },
    });

    if (!entry) return;

    // Get the previous entry's hash for chain linkage
    const prevEntry = await this.prisma.auditLog.findFirst({
      where: {
        tenantId: entry.tenantId,
        timestamp: { lt: entry.timestamp },
        id: { not: entry.id },
      },
      orderBy: { timestamp: 'desc' },
      select: { entryHash: true },
    });

    const prevHash = prevEntry?.entryHash ?? null;

    const entryHash = this.computeEntryHash({
      tenantId: entry.tenantId,
      userId: entry.userId,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId,
      timestamp: entry.timestamp,
      prevHash,
    });

    await this.prisma.auditLog.update({
      where: { id: auditLogId },
      data: { entryHash, prevHash },
    });
  }
}
