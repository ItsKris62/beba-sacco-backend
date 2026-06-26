import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { ImportExecutionService } from '../import-execution.service';
import type { ImportJobPayload } from '../dto/import.dto';

const IMPORT_QUEUE = 'data.import';

@Processor(IMPORT_QUEUE)
export class ImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ImportProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly executionService: ImportExecutionService,
  ) {
    super();
  }

  async process(job: Job<ImportJobPayload>): Promise<void> {
    const { importJobId, tenantId } = job.data;

    const importLog = await this.prisma.dataImportLog.findFirst({
      where: { id: importJobId, tenantId },
      select: {
        id: true,
        batchId: true,
        initiatedBy: true,
        dryRun: true,
        errorDetails: true,
      },
    });

    if (!importLog) {
      throw new Error(`Import log ${importJobId} not found`);
    }

    const rows = importLog.errorDetails as never[];
    if (!Array.isArray(rows)) {
      throw new Error(`Import log ${importJobId} has no persisted validated rows`);
    }

    const firstStage = await this.prisma.stage.findFirst({
      where: { tenantId },
      select: { wardId: true },
    });
    const wardId = firstStage?.wardId ?? '';

    this.logger.log(
      `Processing import job ${job.id}: importJobId=${importJobId}, rows=${rows.length}, dryRun=${importLog.dryRun}`,
    );

    // Mark as PROCESSING
    await this.prisma.dataImportLog.update({
      where: { id: importJobId },
      data: { status: 'PROCESSING', startedAt: new Date() },
    });

    try {
      const report = await this.executionService.executeImport({
        importLogId: importJobId,
        batchId: importLog.batchId,
        tenantId,
        wardId,
        actorId: importLog.initiatedBy,
        dryRun: importLog.dryRun,
        rows,
      });

      // Determine final status
      const finalStatus =
        report.failedCount === 0
          ? 'COMPLETED'
          : report.successCount === 0
          ? 'FAILED'
          : 'PARTIAL';

      // Update import log with results
      await this.prisma.dataImportLog.update({
        where: { id: importJobId },
        data: {
          status: finalStatus,
          successCount: report.successCount,
          failedCount: report.failedCount,
          warningCount: report.warningCount,
          skippedCount: report.skippedCount,
          reportData: report as never,
          completedAt: new Date(),
        },
      });

      this.logger.log(
        `Import job ${job.id} completed: status=${finalStatus}, ` +
        `success=${report.successCount}, failed=${report.failedCount}`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Import job ${job.id} failed: ${errMsg}`);

      await this.prisma.dataImportLog.update({
        where: { id: importJobId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          errorDetails: { fatalError: errMsg } as never,
        },
      });

      throw err; // Re-throw so BullMQ marks the job as failed
    }
  }
}

