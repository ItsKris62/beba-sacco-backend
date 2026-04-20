import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { generateImportEmail } from './utils/name-parser';
import { applyKnownAliases } from './utils/fuzzy-matcher';
import type { ValidatedRow, ImportReport } from './dto/import.dto';
import * as argon2 from 'argon2';

/** Batch size for Prisma transactions */
const BATCH_SIZE = 50;

/** Failure threshold: if > 10% of rows fail, halt the job */
const FAILURE_THRESHOLD = 0.1;

@Injectable()
export class ImportExecutionService {
  private readonly logger = new Logger(ImportExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Execute the import of validated rows.
   * Processes in batches of BATCH_SIZE using Prisma transactions.
   * Halts if failure rate exceeds FAILURE_THRESHOLD.
   */
  async executeImport(params: {
    importLogId: string;
    batchId: string;
    tenantId: string;
    wardId: string;
    actorId: string;
    dryRun: boolean;
    rows: ValidatedRow[];
  }): Promise<ImportReport> {
    const { importLogId, batchId, tenantId, wardId, actorId, dryRun, rows } = params;

    // Only process rows that are not SKIP/ERROR
    const processableRows = rows.filter(r => r.action !== 'SKIP' && r.status !== 'ERROR');
    const skippedRows = rows.filter(r => r.action === 'SKIP' || r.status === 'ERROR');

    this.logger.log(
      `Starting import: ${processableRows.length} processable, ${skippedRows.length} skipped, dryRun=${dryRun}`,
    );

    const report: ImportReport = {
      batchId,
      importLogId,
      totalRows: rows.length,
      successCount: 0,
      failedCount: skippedRows.length,
      warningCount: 0,
      skippedCount: skippedRows.length,
      dryRun,
      errors: skippedRows.flatMap(r =>
        r.errors.map(e => ({ row: r.rowNumber, ...e })),
      ),
      createdUsers: [],
      updatedUsers: [],
      createdStages: [],
    };

    if (dryRun) {
      // Dry run: just count what would happen
      report.successCount = processableRows.filter(r => r.action === 'CREATE').length;
      report.warningCount = processableRows.filter(r => r.status === 'WARNING').length;
      this.logger.log('Dry run complete – no DB writes performed');
      return report;
    }

    // Ensure ward exists
    const ward = await this.prisma.ward.findUnique({ where: { id: wardId } });
    if (!ward) {
      throw new Error(`Ward ${wardId} not found`);
    }

    // Pre-create a default password hash for imported users
    // Imported users must change password on first login
    const defaultPasswordHash = await argon2.hash(`Import@${batchId.slice(0, 8)}`);

    // Process in batches
    const batches = chunk(processableRows, BATCH_SIZE);
    let processedCount = 0;

    for (const batch of batches) {
      const batchResults = await this.processBatch({
        batch,
        tenantId,
        wardId,
        actorId,
        batchId,
        defaultPasswordHash,
        report,
      });

      processedCount += batch.length;
      const failureRate = report.failedCount / rows.length;

      if (failureRate > FAILURE_THRESHOLD && processedCount < processableRows.length) {
        this.logger.warn(
          `Failure rate ${(failureRate * 100).toFixed(1)}% exceeds threshold ${FAILURE_THRESHOLD * 100}%. Halting import.`,
        );
        report.errors.push({
          row: 0,
          field: 'BATCH',
          value: null,
          reason: `Import halted: failure rate ${(failureRate * 100).toFixed(1)}% exceeded ${FAILURE_THRESHOLD * 100}% threshold`,
          errorCode: 'BATCH_FAILURE_THRESHOLD_EXCEEDED',
        });
        break;
      }

      this.logger.debug(`Processed batch: ${processedCount}/${processableRows.length}`);
    }

    // Audit log
    await this.audit
      .create({
        tenantId,
        userId: actorId,
        action: 'BULK_IMPORT',
        resource: 'DataImportLog',
        resourceId: importLogId,
        metadata: {
          batchId,
          totalRows: rows.length,
          successCount: report.successCount,
          failedCount: report.failedCount,
          createdUsers: report.createdUsers.length,
          updatedUsers: report.updatedUsers.length,
          createdStages: report.createdStages.length,
          dryRun,
        },
      })
      .catch(e => this.logger.error('Audit write failed', e));

    return report;
  }

  /**
   * Process a single batch of rows in a Prisma transaction.
   */
  private async processBatch(params: {
    batch: ValidatedRow[];
    tenantId: string;
    wardId: string;
    actorId: string;
    batchId: string;
    defaultPasswordHash: string;
    report: ImportReport;
  }): Promise<void> {
    const { batch, tenantId, wardId, actorId, batchId, defaultPasswordHash, report } = params;

    for (const row of batch) {
      try {
        await this.processRow({
          row,
          tenantId,
          wardId,
          batchId,
          defaultPasswordHash,
          report,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Row ${row.rowNumber} failed: ${errMsg}`);
        report.failedCount++;
        report.errors.push({
          row: row.rowNumber,
          field: 'SYSTEM',
          value: null,
          reason: errMsg,
          errorCode: 'ROW_PROCESSING_ERROR',
        });
      }
    }
  }

  /**
   * Process a single row: upsert User + Stage + StageAssignment.
   */
  private async processRow(params: {
    row: ValidatedRow;
    tenantId: string;
    wardId: string;
    batchId: string;
    defaultPasswordHash: string;
    report: ImportReport;
  }): Promise<void> {
    const { row, tenantId, wardId, batchId, defaultPasswordHash, report } = params;

    await this.prisma.$transaction(async (tx) => {
      // ── 1. Upsert Stage ───────────────────────────────────────────────────
      const canonicalStageName = row.fuzzyStageMatch?.matched
        ?? (row.stageName ? applyKnownAliases(row.stageName) : 'UNASSIGNED');

      let stage = await tx.stage.findFirst({
        where: {
          name: { equals: canonicalStageName, mode: 'insensitive' },
          wardId,
          tenantId,
        },
      });

      if (!stage) {
        stage = await tx.stage.create({
          data: { name: canonicalStageName, wardId, tenantId },
        });
        if (!report.createdStages.includes(canonicalStageName)) {
          report.createdStages.push(canonicalStageName);
        }
      }

      // ── 2. Upsert User ────────────────────────────────────────────────────
      let userId: string;

      if (row.action === 'UPDATE' && row.existingUserId) {
        // Update existing user
        await tx.user.update({
          where: { id: row.existingUserId },
          data: {
            firstName: row.firstName,
            lastName: row.lastName,
            ...(row.idNumber && { idNumber: row.idNumber }),
            ...(row.phoneNumber && { phoneNumber: row.phoneNumber }),
            ...(row.nextOfKinPhone && { nextOfKinPhone: row.nextOfKinPhone }),
            ...(row.legacyNo && { legacyMemberNo: row.legacyNo }),
            importBatchId: batchId,
            wardId,
          },
        });
        userId = row.existingUserId;
        report.updatedUsers.push(userId);
      } else {
        // Create new user
        // Generate a placeholder email (admin should update later)
        const phone = row.phoneNumber ?? row.rawPhone ?? `unknown-${row.rowNumber}`;
        const email = generateImportEmail(row.firstName, row.lastName, phone);

        // Check if email already exists (edge case)
        const emailExists = await tx.user.findUnique({ where: { email } });
        const finalEmail = emailExists
          ? `${email.split('@')[0]}.${row.rowNumber}@import.local`
          : email;

        const newUser = await tx.user.create({
          data: {
            tenantId,
            email: finalEmail,
            passwordHash: defaultPasswordHash,
            role: 'MEMBER',
            firstName: row.firstName,
            lastName: row.lastName,
            idNumber: row.idNumber ?? undefined,
            phoneNumber: row.phoneNumber ?? undefined,
            nextOfKinPhone: row.nextOfKinPhone ?? undefined,
            legacyMemberNo: row.legacyNo ?? undefined,
            importBatchId: batchId,
            wardId,
            userStatus: row.idNumber ? 'ACTIVE' : 'PENDING',
            mustChangePassword: true,
          },
        });
        userId = newUser.id;
        report.createdUsers.push(userId);
      }

      // ── 3. Upsert StageAssignment ─────────────────────────────────────────
      const position = this.mapPosition(row.position);

      // If assigning CHAIRMAN or SECRETARY, deactivate existing holder
      if (position === 'CHAIRMAN' || position === 'SECRETARY') {
        await tx.stageAssignment.updateMany({
          where: { stageId: stage.id, position, isActive: true },
          data: { isActive: false },
        });
      }

      await tx.stageAssignment.upsert({
        where: { userId_stageId: { userId, stageId: stage.id } },
        create: { userId, stageId: stage.id, position, isActive: true },
        update: { position, isActive: true },
      });

      report.successCount++;
      if (row.warnings.length > 0) report.warningCount++;
    });
  }

  /**
   * Map position string to StagePosition enum value.
   */
  private mapPosition(position: string): 'CHAIRMAN' | 'SECRETARY' | 'TREASURER' | 'MEMBER' {
    const map: Record<string, 'CHAIRMAN' | 'SECRETARY' | 'TREASURER' | 'MEMBER'> = {
      CHAIRMAN: 'CHAIRMAN',
      SECRETARY: 'SECRETARY',
      TREASURER: 'TREASURER',
      MEMBER: 'MEMBER',
    };
    return map[position?.toUpperCase()] ?? 'MEMBER';
  }
}

/** Split an array into chunks of size n */
function chunk<T>(arr: T[], n: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += n) {
    result.push(arr.slice(i, i + n));
  }
  return result;
}
