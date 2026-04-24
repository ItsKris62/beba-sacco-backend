import {
  Injectable, Logger, BadRequestException,
  NotFoundException, HttpException, HttpStatus,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { CsvParserService } from './csv-parser.service';
import { ImportValidationService } from './import-validation.service';
import type { ExecuteImportDto, RetryFailedDto, ImportJobPayload } from './dto/import.dto';

const IMPORT_QUEUE = 'data.import';
/** Rate limit: 1 import per tenant per 10 minutes */
const RATE_LIMIT_MS = 10 * 60 * 1000;

@Injectable()
export class DataImportService {
  private readonly logger = new Logger(DataImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly csvParser: CsvParserService,
    private readonly validator: ImportValidationService,
    @InjectQueue(IMPORT_QUEUE) private readonly importQueue: Queue,
  ) {}

  /**
   * Parse + validate CSV, create DataImportLog, return preview report.
   * No DB writes to User/Stage tables.
   */
  async preview(
    file: Express.Multer.File,
    wardId: string,
    tenantId: string,
    actorId: string,
  ) {
    // Validate ward exists
    const ward = await this.prisma.ward.findUnique({ where: { id: wardId } });
    if (!ward) throw new BadRequestException(`Ward '${wardId}' not found`);

    // Parse CSV
    const parsedRows = await this.csvParser.parseBuffer(file.buffer);
    if (parsedRows.length === 0) {
      throw new BadRequestException('CSV file contains no data rows');
    }

    // Create import log (dry-run = true for preview)
    const importLog = await this.prisma.dataImportLog.create({
      data: {
        tenantId,
        initiatedBy: actorId,
        fileName: file.originalname,
        fileSize: file.size,
        totalRows: parsedRows.length,
        dryRun: true,
        status: 'QUEUED',
      },
    });

    // Validate rows
    const report = await this.validator.validateRows(
      parsedRows,
      tenantId,
      wardId,
      importLog.id,
      file.originalname,
    );

    // Store validated rows in the import log for later execution
    await this.prisma.dataImportLog.update({
      where: { id: importLog.id },
      data: {
        totalRows: report.totalRows,
        warningCount: report.warningCount,
        errorDetails: report.rows as never,
        status: 'QUEUED',
      },
    });

    this.logger.log(
      `Preview complete: ${report.totalRows} rows, ${report.validCount} valid, ` +
      `${report.warningCount} warnings, ${report.errorCount} errors`,
    );

    return report;
  }

  /**
   * Queue the import job for async execution.
   */
  async execute(dto: ExecuteImportDto, tenantId: string, actorId: string) {
    const importLog = await this.prisma.dataImportLog.findFirst({
      where: { id: dto.importLogId, tenantId },
    });

    if (!importLog) {
      throw new NotFoundException(`Import log '${dto.importLogId}' not found`);
    }

    if (importLog.status !== 'QUEUED') {
      throw new BadRequestException(
        `Import log is in status '${importLog.status}'. Only QUEUED imports can be executed.`,
      );
    }

    // Rate limiting: check for recent imports by this tenant
    const recentImport = await this.prisma.dataImportLog.findFirst({
      where: {
        tenantId,
        status: { in: ['PROCESSING', 'COMPLETED', 'PARTIAL'] },
        createdAt: { gte: new Date(Date.now() - RATE_LIMIT_MS) },
        id: { not: dto.importLogId },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (recentImport) {
      const waitMs = RATE_LIMIT_MS - (Date.now() - recentImport.createdAt.getTime());
      const waitMin = Math.ceil(waitMs / 60000);
      throw new HttpException(
        `Rate limit: 1 import per tenant per 10 minutes. Please wait ${waitMin} more minute(s).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Get the validated rows from the import log
    const rows = importLog.errorDetails as never;
    if (!rows || !Array.isArray(rows)) {
      throw new BadRequestException('Import log has no validated rows. Please run preview first.');
    }

    // Find the wardId from the first valid row's stage (stored in errorDetails)
    // We need to get wardId from the original preview call
    // For now, get it from the first stage in the tenant
    const firstStage = await this.prisma.stage.findFirst({
      where: { tenantId },
      select: { wardId: true },
    });
    const wardId = firstStage?.wardId ?? '';

    const payload: ImportJobPayload = {
      importLogId: importLog.id,
      tenantId,
      wardId,
      actorId,
      dryRun: dto.dryRun ?? false,
      rows,
    };

    // Queue the job
    const job = await this.importQueue.add('execute-import', payload, {
      attempts: 1, // Import jobs should not auto-retry
      removeOnComplete: false,
      removeOnFail: false,
    });

    // Update import log with job ID
    await this.prisma.dataImportLog.update({
      where: { id: importLog.id },
      data: {
        queueJobId: String(job.id),
        dryRun: dto.dryRun ?? false,
        status: 'QUEUED',
      },
    });

    this.logger.log(`Import job queued: jobId=${job.id}, importLogId=${importLog.id}`);

    return {
      jobId: String(job.id),
      importLogId: importLog.id,
      status: 'QUEUED',
      message: 'Import job queued successfully. Poll /jobs/:jobId for status.',
    };
  }

  /**
   * Get job status by polling the import log.
   */
  async getJobStatus(jobId: string, tenantId: string) {
    const importLog = await this.prisma.dataImportLog.findFirst({
      where: { tenantId, queueJobId: jobId },
      select: {
        id: true,
        batchId: true,
        fileName: true,
        totalRows: true,
        successCount: true,
        failedCount: true,
        warningCount: true,
        skippedCount: true,
        status: true,
        dryRun: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    });

    if (!importLog) {
      throw new NotFoundException(`Job '${jobId}' not found`);
    }

    return {
      jobId,
      importLogId: importLog.id,
      status: importLog.status,
      fileName: importLog.fileName,
      totalRows: importLog.totalRows,
      successCount: importLog.successCount,
      failedCount: importLog.failedCount,
      warningCount: importLog.warningCount,
      skippedCount: importLog.skippedCount,
      dryRun: importLog.dryRun,
      startedAt: importLog.startedAt,
      completedAt: importLog.completedAt,
      createdAt: importLog.createdAt,
    };
  }

  /**
   * Get detailed report for a completed job.
   */
  async getJobReport(jobId: string, tenantId: string) {
    const importLog = await this.prisma.dataImportLog.findFirst({
      where: { tenantId, queueJobId: jobId },
    });

    if (!importLog) {
      throw new NotFoundException(`Job '${jobId}' not found`);
    }

    return {
      jobId,
      importLogId: importLog.id,
      batchId: importLog.batchId,
      fileName: importLog.fileName,
      totalRows: importLog.totalRows,
      successCount: importLog.successCount,
      failedCount: importLog.failedCount,
      warningCount: importLog.warningCount,
      skippedCount: importLog.skippedCount,
      status: importLog.status,
      dryRun: importLog.dryRun,
      reportData: importLog.reportData,
      errorDetails: importLog.errorDetails,
      startedAt: importLog.startedAt,
      completedAt: importLog.completedAt,
    };
  }

  /**
   * List all import jobs for a tenant.
   */
  async getHistory(tenantId: string) {
    const logs = await this.prisma.dataImportLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        batchId: true,
        fileName: true,
        totalRows: true,
        successCount: true,
        failedCount: true,
        warningCount: true,
        status: true,
        dryRun: true,
        queueJobId: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    });

    return { data: logs, total: logs.length };
  }

  /**
   * Retry only failed records from a completed job.
   */
  async retryFailed(dto: RetryFailedDto, tenantId: string, actorId: string) {
    const importLog = await this.prisma.dataImportLog.findFirst({
      where: { id: dto.importLogId, tenantId },
    });

    if (!importLog) {
      throw new NotFoundException(`Import log '${dto.importLogId}' not found`);
    }

    if (!['COMPLETED', 'FAILED', 'PARTIAL'].includes(importLog.status)) {
      throw new BadRequestException(
        `Cannot retry import in status '${importLog.status}'. Only COMPLETED/FAILED/PARTIAL jobs can be retried.`,
      );
    }

    // Get failed rows from errorDetails
    const allRows = (importLog.errorDetails as never[]) ?? [];
    const failedRows = allRows.filter(
      (r: { status: string }) => r.status === 'ERROR',
    );

    if (failedRows.length === 0) {
      throw new BadRequestException('No failed rows to retry');
    }

    // Create a new import log for the retry
    const retryLog = await this.prisma.dataImportLog.create({
      data: {
        tenantId,
        initiatedBy: actorId,
        fileName: `RETRY_${importLog.fileName}`,
        fileSize: 0,
        totalRows: failedRows.length,
        dryRun: false,
        status: 'QUEUED',
        errorDetails: failedRows as never,
      },
    });

    const firstStage = await this.prisma.stage.findFirst({
      where: { tenantId },
      select: { wardId: true },
    });

    const payload: ImportJobPayload = {
      importLogId: retryLog.id,
      tenantId,
      wardId: firstStage?.wardId ?? '',
      actorId,
      dryRun: false,
      rows: failedRows as never,
    };

    const job = await this.importQueue.add('execute-import', payload, {
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });

    await this.prisma.dataImportLog.update({
      where: { id: retryLog.id },
      data: { queueJobId: String(job.id) },
    });

    return {
      jobId: String(job.id),
      importLogId: retryLog.id,
      retryCount: failedRows.length,
      status: 'QUEUED',
    };
  }
}
