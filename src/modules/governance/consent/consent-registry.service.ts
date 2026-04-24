/**
 * Phase 7 – Consent Lifecycle Management
 * Tracks optIn, optOut, version, channel, timestamp.
 * Audit trail exported for DPA compliance.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export type ConsentPurpose =
  | 'CRB_REPORTING'
  | 'AML_SCREENING'
  | 'MARKETING'
  | 'DATA_SHARING'
  | 'ANALYTICS'
  | 'THIRD_PARTY';

export interface ConsentRecord {
  tenantId: string;
  memberId: string;
  purpose: ConsentPurpose;
  granted: boolean;
  version: string;
  channel: 'WEB' | 'MOBILE' | 'USSD' | 'AGENT' | 'SYSTEM';
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class ConsentRegistryService {
  private readonly logger = new Logger(ConsentRegistryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a consent decision (opt-in or opt-out).
   */
  async record(consent: ConsentRecord): Promise<void> {
    await this.prisma.consentRegistry.create({
      data: {
        tenantId: consent.tenantId,
        memberId: consent.memberId,
        purpose: consent.purpose,
        granted: consent.granted,
        version: consent.version,
        channel: consent.channel,
        ipAddress: consent.ipAddress,
        metadata: consent.metadata as Prisma.InputJsonValue | undefined,
        timestamp: new Date(),
      },
    });

    this.logger.log(
      `[Consent] ${consent.granted ? 'GRANTED' : 'REVOKED'} ${consent.purpose} ` +
        `for member ${consent.memberId} (v${consent.version})`,
    );
  }

  /**
   * Check if a member has valid consent for a given purpose.
   * Returns the most recent consent record.
   */
  async hasValidConsent(
    tenantId: string,
    memberId: string,
    purpose: ConsentPurpose,
  ): Promise<boolean> {
    const latest = await this.prisma.consentRegistry.findFirst({
      where: { tenantId, memberId, purpose },
      orderBy: { timestamp: 'desc' },
    });

    return latest?.granted === true;
  }

  /**
   * Get full consent history for a member (DPA audit trail).
   */
  async getConsentHistory(
    tenantId: string,
    memberId: string,
    purpose?: ConsentPurpose,
  ): Promise<unknown[]> {
    return this.prisma.consentRegistry.findMany({
      where: {
        tenantId,
        memberId,
        ...(purpose ? { purpose } : {}),
      },
      orderBy: { timestamp: 'desc' },
    });
  }

  /**
   * Get all active consents for a member.
   */
  async getActiveConsents(tenantId: string, memberId: string): Promise<Record<string, boolean>> {
    const records = await this.prisma.consentRegistry.findMany({
      where: { tenantId, memberId },
      orderBy: { timestamp: 'desc' },
    });

    // Deduplicate: keep latest per purpose
    const latest = new Map<string, boolean>();
    for (const r of records) {
      if (!latest.has(r.purpose)) {
        latest.set(r.purpose, r.granted);
      }
    }

    return Object.fromEntries(latest);
  }

  /**
   * Bulk opt-out: revoke all consents for a member (used in erasure flow).
   */
  async revokeAll(tenantId: string, memberId: string, requestedBy: string): Promise<void> {
    const purposes: ConsentPurpose[] = [
      'CRB_REPORTING', 'AML_SCREENING', 'MARKETING',
      'DATA_SHARING', 'ANALYTICS', 'THIRD_PARTY',
    ];

    for (const purpose of purposes) {
      await this.record({
        tenantId,
        memberId,
        purpose,
        granted: false,
        version: '1.0',
        channel: 'SYSTEM',
        metadata: { revokedBy: requestedBy, reason: 'DATA_ERASURE' },
      });
    }

    this.logger.log(`[Consent] All consents revoked for member ${memberId} by ${requestedBy}`);
  }

  /**
   * Export consent audit trail for DPA compliance (CSV format).
   */
  async exportConsentAuditTrail(tenantId: string): Promise<string> {
    const records = await this.prisma.consentRegistry.findMany({
      where: { tenantId },
      orderBy: { timestamp: 'asc' },
    });

    const header = 'memberId,purpose,granted,version,channel,timestamp,ipAddress\n';
    const rows = records
      .map(
        (r) =>
          `${r.memberId},${r.purpose},${r.granted},${r.version},${r.channel},` +
          `${r.timestamp.toISOString()},${r.ipAddress ?? ''}`,
      )
      .join('\n');

    return header + rows;
  }
}
