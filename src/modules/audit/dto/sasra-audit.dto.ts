import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

// ─── Query DTO ────────────────────────────────────────────────────────────────

export class SasraAuditQueryDto {
  @ApiProperty({
    description: 'Audit window start (ISO 8601 date). Inclusive.',
    example: '2026-04-01',
  })
  @IsDateString()
  startDate!: string;

  @ApiProperty({
    description: 'Audit window end (ISO 8601 date). Inclusive.',
    example: '2026-04-30',
  })
  @IsDateString()
  endDate!: string;

  @ApiPropertyOptional({
    description: 'Export format. Omit for JSON, set to "csv" for CSV download.',
    example: 'csv',
  })
  @IsOptional()
  @Transform(({ value }) => (value as string)?.toLowerCase())
  format?: 'json' | 'csv';
}

// ─── Report sub-types ─────────────────────────────────────────────────────────

export class SasraMismatchEntry {
  @ApiProperty() mpesaTxId!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() maskedPhone!: string;   // 254***{last4} – never raw MSISDN
  @ApiProperty() mpesaAmount!: string;   // Decimal string
  @ApiPropertyOptional() ledgerAmount?: string;
  @ApiProperty() issue!: string;         // Human-readable description of the drift
  @ApiProperty() detectedAt!: string;    // ISO timestamp
}

export class SasraStalePendingEntry {
  @ApiProperty() mpesaTxId!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() maskedPhone!: string;
  @ApiProperty() amount!: string;
  @ApiProperty() createdAt!: string;     // ISO timestamp of original creation
  @ApiProperty() ageHours!: number;
  @ApiProperty() hasDlqEntry!: boolean;
}

export class SasraAuditSummary {
  @ApiProperty({ description: 'Total MpesaTransaction rows in the audit window' })
  totalTransactions!: number;

  @ApiProperty({ description: 'Count with status=COMPLETED' })
  completedCount!: number;

  @ApiProperty({ description: 'Count with status=FAILED' })
  failedCount!: number;

  @ApiProperty({ description: 'Count with status=PENDING (including stale)' })
  pendingCount!: number;

  @ApiProperty({ description: 'Rows missing required SASRA fields' })
  missingFieldsCount!: number;

  @ApiProperty({ description: 'Transactions with timestamp skew > 5 min from server time' })
  timestampSkewCount!: number;

  @ApiProperty({ description: 'Ledger amount mismatches detected' })
  mismatchCount!: number;

  @ApiProperty({ description: 'PENDING rows older than 24h without DLQ or FAILED status' })
  stalePendingCount!: number;

  @ApiProperty({ description: 'Jobs currently sitting in callback DLQ' })
  dlqCount!: number;

  @ApiProperty({ description: 'Percentage of transactions passing all SASRA checks (0–100)' })
  compliancePercent!: number;

  @ApiProperty({ description: 'Audit window start (EAT)' })
  periodStart!: string;

  @ApiProperty({ description: 'Audit window end (EAT)' })
  periodEnd!: string;

  @ApiProperty({ description: 'Report generated at (ISO, EAT)' })
  generatedAt!: string;
}

export class SasraAuditReport {
  @ApiProperty({ type: SasraAuditSummary })
  summary!: SasraAuditSummary;

  @ApiProperty({ type: [SasraMismatchEntry], description: 'Transactions with ledger drift' })
  mismatches!: SasraMismatchEntry[];

  @ApiProperty({ type: [SasraStalePendingEntry], description: 'PENDING > 24h without resolution' })
  stalePending!: SasraStalePendingEntry[];

  @ApiProperty({ type: [Object], description: 'Rows missing required SASRA fields' })
  missingFields!: Array<{
    mpesaTxId: string;
    reference: string;
    missingFields: string[];
    createdAt: string;
  }>;

  @ApiProperty({ type: [Object], description: 'Rows with timestamp skew > 5 min' })
  timestampSkews!: Array<{
    mpesaTxId: string;
    reference: string;
    skewSeconds: number;
    transactionDate: string;
  }>;
}
