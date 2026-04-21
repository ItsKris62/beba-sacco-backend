/**
 * Sprint 3 – Audit Retention Processor (BullMQ)
 *
 * Runs weekly. Enforces SACCO data retention policy:
 *   - Non-financial audit logs older than 2 years → soft-delete (isArchived=true)
 *   - Financial audit logs older than 7 years → archive to MinIO (stub) + mark archived
 *
 * Queue: audit.retention
 * Job: AUDIT_RETENTION_JOB
 *
 * TODO: Phase 4 – replace MinIO stub with actual S3/MinIO upload
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';

export const AUDIT_RETENTION_QUEUE = 'audit.retention';
export const AUDIT_RETENTION_JOB = 'run-retention-policy';

// Retention periods
const NON_FINANCIAL_RETENTION_YEARS = 2;
const FINANCIAL_RETENTION_YEARS = 7;

// Financial action prefixes that require 7-year retention
const FINANCIAL_ACTION_PREFIXES = [
  'FINANCIAL.',
  'LOAN.',
  'REPAYMENT.',
  'SAVINGS.',
  'WELFARE.',
  'DISBURSEMENT.',
];

@Processor(AUDIT_RETENTION_QUEUE)
export class AuditRetentionProcessor extends WorkerHost {
  private readonly logger = new Logger(AuditRetentionProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== AUDIT_RETENTION_JOB) {
      this.logger.warn(`Unknown job: ${job.name}`);
      return;
    }

    this.logger.log('Starting audit retention policy run…');

    const now = new Date();

    // ── Non-financial: soft-delete logs older than 2 years ──────────────────
    const nonFinancialCutoff = new Date(now);
    nonFinancialCutoff.setFullYear(now.getFullYear() - NON_FINANCIAL_RETENTION_YEARS);

    const nonFinancialResult = await this.prisma.auditLog.updateMany({
      where: {
        createdAt: { lt: nonFinancialCutoff },
        isArchived: false,
        // Exclude financial actions
        NOT: {
          action: {
            in: await this.getFinancialActions(),
          },
        },
      },
      data: {
        isArchived: true,
        retentionUntil: nonFinancialCutoff,
      },
    });

    this.logger.log(`Archived ${nonFinancialResult.count} non-financial audit logs (>2 years)`);

    // ── Financial: archive logs older than 7 years ───────────────────────────
    const financialCutoff = new Date(now);
    financialCutoff.setFullYear(now.getFullYear() - FINANCIAL_RETENTION_YEARS);

    const financialLogs = await this.prisma.auditLog.findMany({
      where: {
        createdAt: { lt: financialCutoff },
        isArchived: false,
        action: { in: await this.getFinancialActions() },
      },
      take: 1000, // Process in batches
    });

    let financialArchived = 0;
    for (const log of financialLogs) {
      const archivePath = await this.archiveToStorage(log);

      await this.prisma.auditLog.update({
        where: { id: log.id },
        data: {
          isArchived: true,
          archivePath,
          retentionUntil: financialCutoff,
        },
      });
      financialArchived++;
    }

    this.logger.log(`Archived ${financialArchived} financial audit logs (>7 years) to storage`);

    // ── Log the retention run itself ─────────────────────────────────────────
    await this.auditService.create({
      tenantId: 'SYSTEM',
      userId: 'SYSTEM',
      action: 'AUDIT.RETENTION.COMPLETED',
      resource: 'AuditLog',
      metadata: {
        nonFinancialArchived: nonFinancialResult.count,
        financialArchived,
        runAt: now.toISOString(),
        nonFinancialCutoff: nonFinancialCutoff.toISOString(),
        financialCutoff: financialCutoff.toISOString(),
      },
    });

    this.logger.log('Audit retention policy run completed');
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async getFinancialActions(): Promise<string[]> {
    // Get distinct financial actions from audit log
    const actions = await this.prisma.auditLog.findMany({
      distinct: ['action'],
      select: { action: true },
    });

    return actions
      .map((a) => a.action)
      .filter((action) =>
        FINANCIAL_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix)),
      );
  }

  /**
   * Archive a log entry to MinIO/S3.
   * TODO: Phase 4 – implement actual MinIO upload
   */
  private async archiveToStorage(log: { id: string; tenantId: string; createdAt: Date }): Promise<string> {
    // Stub: return a path that would be used in MinIO
    const year = log.createdAt.getFullYear();
    const month = String(log.createdAt.getMonth() + 1).padStart(2, '0');
    const archivePath = `audit-archive/${log.tenantId}/${year}/${month}/${log.id}.json`;

    // TODO: Phase 4 – upload to MinIO
    // await this.minioService.putObject('audit-archive', archivePath, JSON.stringify(log));

    this.logger.debug(`[STUB] Would archive log ${log.id} to ${archivePath}`);
    return archivePath;
  }
}
