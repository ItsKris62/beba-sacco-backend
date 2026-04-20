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
    const { importLogId, tenantId, wardId, actorId, dryRun, rows } = job.data;

    this.logger.log(
      `Processing import job ${job.id}: importLogId=${importLogId}, rows=${rows.length}, dryRun=${dryRun}`,
    );

    // Mark as PROCESSING
    await this.prisma.dataImportLog.update({
      where: { id: importLogId },
      data: { status: 'PROCESSING', startedAt: new Date() },
    });

    try {
      // Get the batchId from the import log
      const importLog = await this.prisma.dataImportLog.findUnique({
        where: { id: importLogId },
        select: { batchId: true },
      });

      if (!importLog) {
        throw new Error(`Import log ${importLogId} not found`);
      }

      const report = await this.executionService.executeImport({
        importLogId,
        batchId: importLog.batchId,
        tenantId,
        wardId,
        actorId,
        dryRun,
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
        where: { id: importLogId },
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
        where: { id: importLogId },
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
