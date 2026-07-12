import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { LoanStatus } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  CAPTURE_LOAN_ARREARS_SNAPSHOT_JOB,
  LoanArrearsSnapshotJobPayload,
  QUEUE_NAMES,
} from '../queue.constants';

const SNAPSHOT_LOAN_STATUSES: LoanStatus[] = [
  LoanStatus.ACTIVE,
  LoanStatus.DISBURSED,
  LoanStatus.DEFAULTED,
];

function toSnapshotDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/**
 * Captures current stored Loan.arrearsDays/staging into a tenant-scoped daily
 * snapshot table. Retries update the same unique snapshot row.
 */
@Processor(QUEUE_NAMES.LOAN_ARREARS_SNAPSHOT, { concurrency: 2 })
export class LoanArrearsSnapshotProcessor extends WorkerHost {
  private readonly logger = new Logger(LoanArrearsSnapshotProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(
    job: Job<LoanArrearsSnapshotJobPayload>,
  ): Promise<{ processed: number; skipped: number }> {
    if (job.name !== CAPTURE_LOAN_ARREARS_SNAPSHOT_JOB) {
      this.logger.warn(`Ignoring unsupported job ${job.name}`);
      return { processed: 0, skipped: 0 };
    }

    if (process.env.ENABLE_LOAN_ARREARS_SNAPSHOT_JOB !== 'true') {
      this.logger.log('Loan arrears snapshot job is disabled via environment.');
      return { processed: 0, skipped: 0 };
    }

    const { tenantId, snapshotDate } = job.data;
    const snapshotDateValue = toSnapshotDate(snapshotDate);
    const loans = await this.prisma.loan.findMany({
      where: {
        tenantId,
        status: { in: SNAPSHOT_LOAN_STATUSES },
      },
      select: {
        id: true,
        tenantId: true,
        arrearsDays: true,
        staging: true,
      },
      orderBy: { id: 'asc' },
    });

    let processed = 0;
    let skipped = 0;
    const capturedAt = new Date();

    for (const loan of loans) {
      try {
        await this.prisma.loanArrearsSnapshot.upsert({
          where: {
            tenantId_loanId_snapshotDate: {
              tenantId: loan.tenantId,
              loanId: loan.id,
              snapshotDate: snapshotDateValue,
            },
          },
          create: {
            tenantId: loan.tenantId,
            loanId: loan.id,
            snapshotDate: snapshotDateValue,
            arrearsDays: loan.arrearsDays,
            staging: loan.staging,
            capturedAt,
          },
          update: {
            arrearsDays: loan.arrearsDays,
            staging: loan.staging,
            capturedAt,
          },
        });
        processed++;
      } catch (err) {
        this.logger.error(`Loan arrears snapshot failed for loan ${loan.id}`, err);
        skipped++;
      }
    }

    this.logger.log(
      `Loan arrears snapshot complete: tenant=${tenantId} date=${snapshotDate} processed=${processed} skipped=${skipped}`,
    );
    return { processed, skipped };
  }
}
