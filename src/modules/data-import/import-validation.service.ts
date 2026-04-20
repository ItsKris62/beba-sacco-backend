import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { fuzzyMatchStageName, applyKnownAliases } from './utils/fuzzy-matcher';
import type {
  ParsedCsvRow,
  ValidatedRow,
  RowError,
  ImportPreviewReport,
} from './dto/import.dto';

/** Minimum fuzzy confidence to auto-accept a stage match */
const AUTO_ACCEPT_CONFIDENCE = 90;
/** Minimum fuzzy confidence to flag as warning (requires admin review) */
const WARN_CONFIDENCE = 70;

@Injectable()
export class ImportValidationService {
  private readonly logger = new Logger(ImportValidationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validate all parsed rows against business rules and DB state.
   * Returns a full preview report with per-row status.
   */
  async validateRows(
    rows: ParsedCsvRow[],
    tenantId: string,
    wardId: string,
    importLogId: string,
    fileName: string,
  ): Promise<ImportPreviewReport> {
    // Pre-fetch existing users for duplicate detection
    const existingByIdNumber = await this.fetchExistingByIdNumber(tenantId);
    const existingByPhone = await this.fetchExistingByPhone(tenantId);

    // Pre-fetch existing stage names for fuzzy matching
    const existingStages = await this.prisma.stage.findMany({
      where: { tenantId, wardId },
      select: { id: true, name: true },
    });
    const existingStageNames = existingStages.map(s => s.name);

    // Track seen idNumbers and phones within this batch (intra-batch dedup)
    const seenIdNumbers = new Map<string, number>(); // idNumber → first rowNumber
    const seenPhones = new Map<string, number>();    // phone → first rowNumber

    const validatedRows: ValidatedRow[] = [];
    const stageCountMap = new Map<string, { count: number; isNew: boolean }>();

    for (const row of rows) {
      const validated = await this.validateRow(
        row,
        tenantId,
        existingByIdNumber,
        existingByPhone,
        existingStageNames,
        seenIdNumbers,
        seenPhones,
      );
      validatedRows.push(validated);

      // Track stage usage
      const stageName = validated.fuzzyStageMatch?.matched ?? validated.stageName ?? 'UNASSIGNED';
      const isNew = !existingStageNames.some(
        s => s.toUpperCase() === stageName.toUpperCase(),
      );
      const existing = stageCountMap.get(stageName) ?? { count: 0, isNew };
      stageCountMap.set(stageName, { count: existing.count + 1, isNew });
    }

    // Compute summary counts
    const validCount = validatedRows.filter(r => r.status === 'VALID').length;
    const warningCount = validatedRows.filter(r => r.status === 'WARNING').length;
    const errorCount = validatedRows.filter(r => r.status === 'ERROR').length;
    const duplicateCount = validatedRows.filter(r => r.status === 'DUPLICATE').length;

    const stagesSummary = Array.from(stageCountMap.entries()).map(([name, info]) => ({
      name,
      count: info.count,
      isNew: info.isNew,
    }));

    // Can proceed if error rate < 50%
    const canProceed = errorCount / rows.length < 0.5;

    return {
      importLogId,
      fileName,
      totalRows: rows.length,
      validCount,
      warningCount,
      errorCount,
      duplicateCount,
      rows: validatedRows,
      stagesSummary,
      canProceed,
    };
  }

  /**
   * Validate a single row.
   */
  private async validateRow(
    row: ParsedCsvRow,
    tenantId: string,
    existingByIdNumber: Map<string, string>,
    existingByPhone: Map<string, string>,
    existingStageNames: string[],
    seenIdNumbers: Map<string, number>,
    seenPhones: Map<string, number>,
  ): Promise<ValidatedRow> {
    const errors: RowError[] = [];
    const warnings: RowError[] = [];
    let action: 'CREATE' | 'UPDATE' | 'SKIP' = 'CREATE';
    let existingUserId: string | undefined;
    let fuzzyStageMatch: ValidatedRow['fuzzyStageMatch'];

    // ── 1. Name validation ────────────────────────────────────────────────────
    if (!row.firstName || row.firstName === 'Unknown') {
      errors.push({
        field: 'NAME',
        value: null,
        reason: 'Name is missing or could not be parsed',
        errorCode: 'NAME_MISSING',
      });
    }

    // ── 2. ID Number validation ───────────────────────────────────────────────
    if (!row.idNumber) {
      if (row.rawIdNumber) {
        // Has a value but it's invalid (e.g., 9-digit)
        warnings.push({
          field: 'ID NO.',
          value: row.rawIdNumber,
          reason: `ID number '${row.rawIdNumber}' is not a valid Kenyan National ID (7-8 digits). Will be imported as PENDING_VERIFICATION.`,
          errorCode: 'ID_INVALID_FORMAT',
        });
      } else {
        // Completely missing
        warnings.push({
          field: 'ID NO.',
          value: null,
          reason: 'ID number is missing. Will be imported as PENDING_VERIFICATION.',
          errorCode: 'ID_MISSING',
        });
      }
    } else {
      // Check intra-batch duplicate
      if (seenIdNumbers.has(row.idNumber)) {
        warnings.push({
          field: 'ID NO.',
          value: row.idNumber,
          reason: `Duplicate ID number within this import batch (first seen at row ${seenIdNumbers.get(row.idNumber)})`,
          errorCode: 'ID_DUPLICATE_IN_BATCH',
        });
      } else {
        seenIdNumbers.set(row.idNumber, row.rowNumber);
      }

      // Check DB duplicate
      if (existingByIdNumber.has(row.idNumber)) {
        existingUserId = existingByIdNumber.get(row.idNumber);
        action = 'UPDATE';
      }
    }

    // ── 3. Phone validation ───────────────────────────────────────────────────
    if (!row.phoneNumber) {
      if (row.rawPhone) {
        errors.push({
          field: 'PHONE NO.',
          value: row.rawPhone,
          reason: `Phone '${row.rawPhone}' could not be normalized to a valid Kenyan number`,
          errorCode: 'PHONE_INVALID_FORMAT',
        });
      } else {
        errors.push({
          field: 'PHONE NO.',
          value: null,
          reason: 'Phone number is missing',
          errorCode: 'PHONE_MISSING',
        });
      }
    } else {
      // Check intra-batch duplicate
      if (seenPhones.has(row.phoneNumber)) {
        warnings.push({
          field: 'PHONE NO.',
          value: row.phoneNumber,
          reason: `Duplicate phone within this import batch (first seen at row ${seenPhones.get(row.phoneNumber)})`,
          errorCode: 'PHONE_DUPLICATE_IN_BATCH',
        });
      } else {
        seenPhones.set(row.phoneNumber, row.rowNumber);
      }

      // Check DB duplicate
      if (existingByPhone.has(row.phoneNumber)) {
        const phoneUserId = existingByPhone.get(row.phoneNumber)!;
        if (action === 'UPDATE' && existingUserId !== phoneUserId) {
          // ID and phone point to different users – conflict
          errors.push({
            field: 'PHONE NO.',
            value: row.phoneNumber,
            reason: 'Phone number belongs to a different existing user than the ID number',
            errorCode: 'PHONE_ID_CONFLICT',
          });
        } else if (action !== 'UPDATE') {
          existingUserId = phoneUserId;
          action = 'UPDATE';
        }
      }
    }

    // ── 4. Stage name validation ──────────────────────────────────────────────
    if (!row.stageName) {
      warnings.push({
        field: 'STAGE NAME',
        value: null,
        reason: 'Stage name is missing. Will be assigned to UNASSIGNED stage.',
        errorCode: 'STAGE_MISSING',
      });
    } else {
      // Apply known aliases first
      const aliased = applyKnownAliases(row.stageName);
      const fuzzyResult = fuzzyMatchStageName(aliased, existingStageNames);

      if (!fuzzyResult.isExact && fuzzyResult.matched) {
        const confidence = fuzzyResult.confidence;
        if (confidence >= AUTO_ACCEPT_CONFIDENCE) {
          // Auto-accept with warning
          fuzzyStageMatch = {
            original: row.stageName,
            matched: fuzzyResult.matched,
            confidence,
          };
          warnings.push({
            field: 'STAGE NAME',
            value: row.stageName,
            reason: `Stage name fuzzy-matched to '${fuzzyResult.matched}' (${confidence}% confidence). Auto-accepted.`,
            errorCode: 'STAGE_FUZZY_MATCH_AUTO',
          });
        } else if (confidence >= WARN_CONFIDENCE) {
          // Requires admin review
          fuzzyStageMatch = {
            original: row.stageName,
            matched: fuzzyResult.matched,
            confidence,
          };
          warnings.push({
            field: 'STAGE NAME',
            value: row.stageName,
            reason: `Stage name fuzzy-matched to '${fuzzyResult.matched}' (${confidence}% confidence). Requires admin review.`,
            errorCode: 'STAGE_FUZZY_MATCH_REVIEW',
          });
        }
        // else: no match found, will create new stage
      }
    }

    // ── 5. Determine final status ─────────────────────────────────────────────
    let status: ValidatedRow['status'];
    if (errors.length > 0) {
      status = 'ERROR';
      action = 'SKIP';
    } else if (action === 'UPDATE') {
      status = 'DUPLICATE';
    } else if (warnings.length > 0) {
      status = 'WARNING';
    } else {
      status = 'VALID';
    }

    return {
      ...row,
      status,
      errors,
      warnings,
      action,
      existingUserId,
      fuzzyStageMatch,
    };
  }

  /**
   * Pre-fetch all existing users' idNumbers for this tenant.
   */
  private async fetchExistingByIdNumber(tenantId: string): Promise<Map<string, string>> {
    const users = await this.prisma.user.findMany({
      where: { tenantId, idNumber: { not: null } },
      select: { id: true, idNumber: true },
    });
    const map = new Map<string, string>();
    users.forEach(u => {
      if (u.idNumber) map.set(u.idNumber, u.id);
    });
    return map;
  }

  /**
   * Pre-fetch all existing users' phoneNumbers for this tenant.
   */
  private async fetchExistingByPhone(tenantId: string): Promise<Map<string, string>> {
    const users = await this.prisma.user.findMany({
      where: { tenantId, phoneNumber: { not: null } },
      select: { id: true, phoneNumber: true },
    });
    const map = new Map<string, string>();
    users.forEach(u => {
      if (u.phoneNumber) map.set(u.phoneNumber, u.id);
    });
    return map;
  }
}
