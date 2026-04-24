import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../audit.service';

export const AUDIT_RETENTION_QUEUE = 'audit.retention';
export const AUDIT_RETENTION_JOB = 'run-retention-policy';

const NON_FINANCIAL_RETENTION_YEARS = 2;
const FINANCIAL_RETENTION_YEARS = 7;

const FINANCIAL_ACTION_PREFIXES = [
  'FINANCIAL.',
  'LOAN.',
  'REPAYMENT.',
  'SAVINGS.',
  'WELFARE.',
  'DISBURSEMENT.',
];

// Sentinel prefix stored in requestId to mark a log as archived
const ARCHIVED_SENTINEL = 'ARCHIVED:';

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

    // Non-financial: mark logs older than 2 years as archived via requestId sentinel
    const nonFinancialCutoff = new Date(now);
    nonFinancialCutoff.setFullYear(now.getFullYear() - NON_FINANCIAL_RETENTION_YEARS);

    const financialActions = await this.getFinancialActions();

    const nonFinancialResult = await this.prisma.auditLog.updateMany({
      where: {
        timestamp: { lt: nonFinancialCutoff },
        NOT: [
          { requestId: { startsWith: ARCHIVED_SENTINEL } },
          { action: { in: financialActions } },
        ],
      },
      data: {
        requestId: `${ARCHIVED_SENTINEL}${nonFinancialCutoff.toISOString()}`,
      },
    });

    this.logger.log(`Archived ${nonFinancialResult.count} non-financial audit logs (>2 years)`);

    // Financial: archive logs older than 7 years
    const financialCutoff = new Date(now);
    financialCutoff.setFullYear(now.getFullYear() - FINANCIAL_RETENTION_YEARS);

    const financialLogs = await this.prisma.auditLog.findMany({
      where: {
        timestamp: { lt: financialCutoff },
        action: { in: financialActions },
        NOT: { requestId: { startsWith: ARCHIVED_SENTINEL } },
      },
      take: 1000,
    });

    let financialArchived = 0;
    for (const log of financialLogs) {
      const archivePath = await this.archiveToStorage({
        id: log.id,
        tenantId: log.tenantId,
        timestamp: log.timestamp,
      });

      await this.prisma.auditLog.update({
        where: { id: log.id },
        data: { requestId: `${ARCHIVED_SENTINEL}${archivePath}` },
      });
      financialArchived++;
    }

    this.logger.log(`Archived ${financialArchived} financial audit logs (>7 years) to storage`);

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

  private async getFinancialActions(): Promise<string[]> {
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

  // TODO: Phase 4 – replace stub with actual MinIO/S3 upload
  private async archiveToStorage(log: {
    id: string;
    tenantId: string;
    timestamp: Date;
  }): Promise<string> {
    const year = log.timestamp.getFullYear();
    const month = String(log.timestamp.getMonth() + 1).padStart(2, '0');
    const archivePath = `audit-archive/${log.tenantId}/${year}/${month}/${log.id}.json`;
    this.logger.debug(`[STUB] Would archive log ${log.id} to ${archivePath}`);
    return archivePath;
  }
}
