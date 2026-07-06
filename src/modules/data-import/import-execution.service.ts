import { Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';
import { Prisma, StagePosition, UserRole, AccountStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SmsService } from '../sms/sms.service';
import { generateImportEmail } from './utils/name-parser';
import { applyKnownAliases } from './utils/fuzzy-matcher';
import type { ValidatedRow, ImportReport } from './dto/import.dto';
import { provisionMemberAccounts } from '../accounts/utils/provision-accounts.util';
import * as argon2 from 'argon2';

const BATCH_SIZE = 50;
const FAILURE_THRESHOLD = 0.1;
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

@Injectable()
export class ImportExecutionService {
  private readonly logger = new Logger(ImportExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sms: SmsService,
  ) {}

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

    const processableRows = rows.filter(
      (row) => row.action === 'CREATE' && row.status !== 'ERROR' && row.status !== 'DUPLICATE',
    );
    const skippedRows = rows.filter((row) => !processableRows.includes(row));

    this.logger.log(
      `Starting import: ${processableRows.length} processable, ${skippedRows.length} skipped, dryRun=${dryRun}`,
    );

    const report: ImportReport = {
      batchId,
      importLogId,
      totalRows: rows.length,
      successCount: 0,
      failedCount: skippedRows.filter((row) => row.status === 'ERROR').length,
      warningCount: 0,
      skippedCount: skippedRows.length,
      dryRun,
      errors: skippedRows.flatMap((row) =>
        row.errors.map((error) => ({ row: row.rowNumber, ...error })),
      ),
      createdUsers: [],
      updatedUsers: [],
      createdStages: [],
    };

    if (dryRun) {
      report.successCount = processableRows.length;
      report.warningCount = processableRows.filter((row) => row.status === 'WARNING').length;
      this.logger.log('Dry run complete - no DB writes or SMS jobs performed');
      return report;
    }

    const ward = await this.prisma.ward.findUnique({ where: { id: wardId } });
    if (!ward) throw new Error(`Ward ${wardId} not found`);

    const batches = chunk(processableRows, BATCH_SIZE);
    let processedCount = 0;

    for (const batch of batches) {
      await this.processBatch({
        batch,
        tenantId,
        wardId,
        actorId,
        batchId,
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
      .catch((error) => this.logger.error('Audit write failed', error));

    return report;
  }

  private async processBatch(params: {
    batch: ValidatedRow[];
    tenantId: string;
    wardId: string;
    actorId: string;
    batchId: string;
    report: ImportReport;
  }): Promise<void> {
    const { batch, tenantId, wardId, actorId, batchId, report } = params;

    for (const row of batch) {
      try {
        await this.processRow({ row, tenantId, wardId, actorId, batchId, report });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Row ${row.rowNumber} failed: ${message}`);
        report.failedCount++;
        report.errors.push({
          row: row.rowNumber,
          field: 'SYSTEM',
          value: null,
          reason: message,
          errorCode: 'ROW_PROCESSING_ERROR',
        });
      }
    }
  }

  private async processRow(params: {
    row: ValidatedRow;
    tenantId: string;
    wardId: string;
    actorId: string;
    batchId: string;
    report: ImportReport;
  }): Promise<void> {
    const { row, tenantId, wardId, actorId, batchId, report } = params;
    const tempPassword = this.generateTempPassword();
    const passwordHash = await argon2.hash(tempPassword, {
      type: argon2.argon2id,
      memoryCost: 32768,
      timeCost: 3,
      parallelism: 1,
    });

    const created = await this.prisma.$transaction(async (tx) => {
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

      const phone = row.phoneNumber ?? row.rawPhone ?? `unknown-${row.rowNumber}`;
      const email = generateImportEmail(row.firstName, row.lastName, phone);
      const finalEmail = await this.uniqueImportEmail(tx, tenantId, email, row.rowNumber);

      const user = await tx.user.create({
        data: {
          tenantId,
          email: finalEmail,
          passwordHash,
          role: UserRole.MEMBER,
          firstName: row.firstName,
          lastName: row.lastName,
          phone: row.phoneNumber ?? undefined,
          idNumber: row.idNumber ?? undefined,
          phoneNumber: row.phoneNumber ?? undefined,
          nextOfKinPhone: row.nextOfKinPhone ?? undefined,
          legacyMemberNo: row.legacyNo ?? undefined,
          importBatchId: batchId,
          wardId,
          accountStatus: AccountStatus.ACTIVE,
          mustChangePassword: true,
          createdById: actorId,
          approvedById: actorId,
          approvedAt: new Date(),
          approvalReason: 'Imported from cleaned member CSV',
        },
      });

      const member = await tx.member.create({
        data: {
          tenantId,
          userId: user.id,
          memberNumber: await this.generateUniqueMemberNumber(tx, tenantId),
          nationalId: row.idNumber ?? undefined,
        },
      });

      // Auto-provision FOSA + BOSA accounts (idempotent, snapshots AccountTypePolicy)
      await provisionMemberAccounts(tx, tenantId, member.id);

      await tx.stageAssignment.upsert({
        where: { userId_stageId: { userId: user.id, stageId: stage.id } },
        create: {
          userId: user.id,
          stageId: stage.id,
          position: this.mapPosition(row.position),
          isActive: true,
        },
        update: {
          position: this.mapPosition(row.position),
          isActive: true,
        },
      });

      await tx.memberStage.upsert({
        where: { memberId_stageId: { memberId: member.id, stageId: stage.id } },
        create: {
          memberId: member.id,
          stageId: stage.id,
          assignedBy: actorId,
          isActive: true,
        },
        update: { assignedBy: actorId, isActive: true },
      });

      report.successCount++;
      if (row.warnings.length > 0) report.warningCount++;
      report.createdUsers.push(user.id);

      return { userId: user.id, phone: row.phoneNumber, tempPassword };
    });

    if (created.phone) {
      await this.sms.enqueueSms(
        {
          type: 'TEMP_PASSWORD',
          phone: created.phone,
          message:
            `Welcome to Beba SACCO. Login with your phone number ${created.phone} ` +
            `and temporary password: ${created.tempPassword}. You will be required to change it immediately.`,
        },
        `data-import.temp-password:${created.userId}`,
      );
    }
  }

  private mapPosition(position: string): StagePosition {
    const upper = position?.toUpperCase();
    if (upper === StagePosition.CHAIRMAN) return StagePosition.CHAIRMAN;
    if (upper === StagePosition.SECRETARY) return StagePosition.SECRETARY;
    if (upper === StagePosition.TREASURER) return StagePosition.TREASURER;
    return StagePosition.MEMBER;
  }

  private generateTempPassword(length = 10): string {
    return Array.from(
      { length },
      () => PASSWORD_ALPHABET[randomInt(0, PASSWORD_ALPHABET.length)],
    ).join('');
  }

  private async generateUniqueMemberNumber(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `MBR-${randomInt(100000, 1000000)}`;
      const existing = await tx.member.findFirst({
        where: { tenantId, memberNumber: candidate },
        select: { id: true },
      });
      if (!existing) return candidate;
    }
    throw new Error('Could not generate a unique member number');
  }

  private async uniqueImportEmail(
    tx: Prisma.TransactionClient,
    tenantId: string,
    email: string,
    rowNumber: number,
  ): Promise<string> {
    const existing = await tx.user.findFirst({
      where: { tenantId, email },
      select: { id: true },
    });
    if (!existing) return email;

    const [local, domain] = email.split('@');
    return `${local}.${rowNumber}.${Date.now()}@${domain}`;
  }
}

function chunk<T>(arr: T[], n: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += n) {
    result.push(arr.slice(i, i + n));
  }
  return result;
}
