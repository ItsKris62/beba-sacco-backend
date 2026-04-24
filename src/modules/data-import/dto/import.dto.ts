import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class ExecuteImportDto {
  @ApiProperty({ description: 'The import log ID returned from the preview step' })
  @IsUUID()
  importLogId!: string;

  @ApiPropertyOptional({ description: 'If true, execute as dry-run (no DB writes)', default: false })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  dryRun?: boolean;
}

export class RetryFailedDto {
  @ApiProperty({ description: 'The import log ID of the completed/failed job' })
  @IsUUID()
  importLogId!: string;
}

// ─── Row-level validation result ─────────────────────────────────────────────

export type RowStatus = 'VALID' | 'WARNING' | 'ERROR' | 'DUPLICATE';

export interface RowError {
  field: string;
  value: string | null;
  reason: string;
  errorCode: string;
}

export interface ParsedCsvRow {
  /** Original CSV row number (1-based, after header) */
  rowNumber: number;
  /** CSV "NO." column */
  legacyNo: string | null;
  /** Parsed first name */
  firstName: string;
  /** Parsed last name */
  lastName: string;
  /** Raw ID number from CSV */
  rawIdNumber: string | null;
  /** Normalized ID number (7-8 digits) or null */
  idNumber: string | null;
  /** Raw phone from CSV */
  rawPhone: string | null;
  /** Normalized phone in E.164 (2547xxxxxxxx) or null */
  phoneNumber: string | null;
  /** Stage name from CSV */
  stageName: string | null;
  /** Position from CSV */
  position: string;
  /** Next of kin phone (raw) */
  nextOfKinPhone: string | null;
  /** Sub-county from CSV */
  subCounty: string | null;
  /** Ward chairman phone */
  wardChairman: string | null;
}

export interface ValidatedRow extends ParsedCsvRow {
  status: RowStatus;
  errors: RowError[];
  warnings: RowError[];
  /** Whether this row would be an UPDATE (existing user) or CREATE */
  action: 'CREATE' | 'UPDATE' | 'SKIP';
  /** Existing user ID if action=UPDATE */
  existingUserId?: string;
  /** Fuzzy-matched stage name if confidence < 100% */
  fuzzyStageMatch?: { original: string; matched: string; confidence: number };
}

export interface ImportPreviewReport {
  importLogId: string;
  fileName: string;
  totalRows: number;
  validCount: number;
  warningCount: number;
  errorCount: number;
  duplicateCount: number;
  rows: ValidatedRow[];
  stagesSummary: { name: string; count: number; isNew: boolean }[];
  canProceed: boolean; // false if error rate > 50%
}

export interface ImportJobPayload {
  importLogId: string;
  tenantId: string;
  wardId: string;
  actorId: string;
  dryRun: boolean;
  rows: ValidatedRow[];
}

export interface ImportReport {
  batchId: string;
  importLogId: string;
  totalRows: number;
  successCount: number;
  failedCount: number;
  warningCount: number;
  skippedCount: number;
  dryRun: boolean;
  errors: Array<{
    row: number;
    field: string;
    value: string | null;
    reason: string;
    errorCode: string;
  }>;
  createdUsers: string[];
  updatedUsers: string[];
  createdStages: string[];
}
