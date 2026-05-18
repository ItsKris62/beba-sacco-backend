import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';

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
  'MPESA.',
];

@Processor(AUDIT_RETENTION_QUEUE)
export class AuditRetentionProcessor extends WorkerHost {
  private readonly logger = new Logger(AuditRetentionProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== AUDIT_RETENTION_JOB) {
      this.logger.warn(`Unknown job: ${job.name}`);
      return;
    }

    const now = new Date();
    const financialActions = await this.getFinancialActions();

    const nonFinancialCutoff = this.yearsAgo(now, NON_FINANCIAL_RETENTION_YEARS);
    const nonFinancialCounts = await this.prisma.auditLog.groupBy({
      by: ['tenantId'],
      where: {
        timestamp: { lt: nonFinancialCutoff },
        NOT: [{ action: { in: financialActions } }],
      },
      _count: { _all: true },
    });
    for (const row of nonFinancialCounts) {
      await this.createArchiveManifest({
        tenantId: row.tenantId,
        archiveClass: 'NON_FINANCIAL',
        cutoff: nonFinancialCutoff,
        rowCount: row._count._all,
      });
    }

    const financialCutoff = this.yearsAgo(now, FINANCIAL_RETENTION_YEARS);
    const financialCounts = await this.prisma.auditLog.groupBy({
      by: ['tenantId'],
      where: {
        timestamp: { lt: financialCutoff },
        action: { in: financialActions },
      },
      _count: { _all: true },
    });
    for (const row of financialCounts) {
      await this.createArchiveManifest({
        tenantId: row.tenantId,
        archiveClass: 'FINANCIAL',
        cutoff: financialCutoff,
        rowCount: row._count._all,
      });
    }

    this.logger.log(
      `Audit retention manifests created: nonFinancialTenants=${nonFinancialCounts.length}, financialTenants=${financialCounts.length}`,
    );
  }

  private yearsAgo(now: Date, years: number): Date {
    const cutoff = new Date(now);
    cutoff.setFullYear(now.getFullYear() - years);
    return cutoff;
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

  private async createArchiveManifest(input: {
    tenantId: string;
    archiveClass: string;
    cutoff: Date;
    rowCount: number;
  }): Promise<string> {
    const year = input.cutoff.getFullYear();
    const month = String(input.cutoff.getMonth() + 1).padStart(2, '0');
    const objectUri = `worm://audit-archive/${input.tenantId}/${input.archiveClass.toLowerCase()}/${year}/${month}/manifest.json`;
    const manifestPayload = JSON.stringify({
      ...input,
      cutoff: input.cutoff.toISOString(),
      objectUri,
    });

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO audit_archive_manifests (
        "tenantId",
        "archiveClass",
        "cutoffAt",
        "objectUri",
        "rowCount",
        "manifestHash"
      )
      VALUES (
        ${input.tenantId},
        ${input.archiveClass},
        ${input.cutoff},
        ${objectUri},
        ${input.rowCount},
        encode(digest(${manifestPayload}, 'sha256'), 'hex')
      )
      RETURNING id
    `);

    return rows[0]?.id ?? objectUri;
  }
}
