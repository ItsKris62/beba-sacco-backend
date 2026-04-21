/**
 * Sprint 3 – Financial Import DTOs
 * Maps CSV columns → validated Prisma models for Loan, LoanRepayment,
 * SavingsRecord, and GroupWelfareCollection sheets.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsOptional,
  IsDateString,
  IsEnum,
  IsArray,
  ValidateNested,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

// ─── Loan Disbursement Row ────────────────────────────────────────────────────

export class LoanDisbursementRowDto {
  @ApiProperty({ description: 'Member ID number (Kenyan National ID)' })
  @IsString()
  idNumber!: string;

  @ApiProperty({ description: 'Member full name from CSV' })
  @IsString()
  memberName!: string;

  @ApiProperty({ description: 'Loan principal amount in KES' })
  @IsNumber()
  @Min(0)
  principal!: number;

  @ApiProperty({ description: 'Disbursement date (ISO 8601)' })
  @IsDateString()
  disbursedDate!: string;

  @ApiProperty({ description: 'Loan due date (ISO 8601)' })
  @IsDateString()
  dueDate!: string;

  @ApiPropertyOptional({ description: 'Loan purpose / description' })
  @IsOptional()
  @IsString()
  purpose?: string;

  @ApiPropertyOptional({ description: 'CSV row number for error reporting' })
  @IsOptional()
  @IsNumber()
  rowNumber?: number;
}

// ─── Loan Repayment Row ───────────────────────────────────────────────────────

export class LoanRepaymentRowDto {
  @ApiProperty({ description: 'Member ID number' })
  @IsString()
  idNumber!: string;

  @ApiProperty({ description: 'Day number in 30-day schedule (1–30)' })
  @IsNumber()
  @Min(1)
  @Max(30)
  dayNumber!: number;

  @ApiProperty({ description: 'Amount paid in KES' })
  @IsNumber()
  @Min(0)
  amountPaid!: number;

  @ApiProperty({ description: 'Payment date (ISO 8601)' })
  @IsDateString()
  paymentDate!: string;

  @ApiPropertyOptional({ description: 'Payment method (CASH, MPESA, etc.)' })
  @IsOptional()
  @IsString()
  method?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  rowNumber?: number;
}

// ─── Savings Record Row ───────────────────────────────────────────────────────

export class SavingsRecordRowDto {
  @ApiProperty({ description: 'Member ID number (null for group welfare)' })
  @IsOptional()
  @IsString()
  idNumber?: string;

  @ApiProperty({ description: 'Week number (1–52)' })
  @IsNumber()
  @Min(1)
  @Max(52)
  weekNumber!: number;

  @ApiProperty({ description: 'Savings amount in KES' })
  @IsNumber()
  @Min(0)
  amount!: number;

  @ApiProperty({ description: 'Period date (ISO 8601)' })
  @IsDateString()
  periodDate!: string;

  @ApiPropertyOptional({ description: 'Group name for group welfare entries' })
  @IsOptional()
  @IsString()
  groupName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  rowNumber?: number;
}

// ─── Group Welfare (Receivership) Row ────────────────────────────────────────

export class GroupWelfareRowDto {
  @ApiProperty({ description: 'Stage/group name' })
  @IsString()
  stageName!: string;

  @ApiProperty({ description: 'Week number (1–52)' })
  @IsNumber()
  @Min(1)
  @Max(52)
  weekNumber!: number;

  @ApiProperty({ description: 'Amount collected in KES' })
  @IsNumber()
  @Min(0)
  amountCollected!: number;

  @ApiProperty({ description: 'Period date (ISO 8601)' })
  @IsDateString()
  periodDate!: string;

  @ApiPropertyOptional({ description: 'Weekly target (default 300 KES)' })
  @IsOptional()
  @IsNumber()
  weeklyTarget?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  rowNumber?: number;
}

// ─── Financial Preview Request ────────────────────────────────────────────────

export enum FinancialSheetType {
  LOAN_DISBURSEMENT = 'LOAN_DISBURSEMENT',
  LOAN_REPAYMENT = 'LOAN_REPAYMENT',
  SACCO_SAVINGS = 'SACCO_SAVINGS',
  GROUP_WELFARE = 'GROUP_WELFARE',
}

export class FinancialPreviewRequestDto {
  @ApiProperty({ enum: FinancialSheetType })
  @IsEnum(FinancialSheetType)
  sheetType!: FinancialSheetType;

  @ApiPropertyOptional({ description: 'Dry run – validate only, no DB writes' })
  @IsOptional()
  dryRun?: boolean;
}

// ─── Financial Preview Response ───────────────────────────────────────────────

export class FinancialPreviewRowResult {
  @ApiProperty()
  rowNumber!: number;

  @ApiProperty()
  status!: 'VALID' | 'WARNING' | 'ERROR';

  @ApiPropertyOptional()
  message?: string;

  @ApiPropertyOptional()
  resolvedMemberId?: string;

  @ApiPropertyOptional()
  resolvedLoanId?: string;

  @ApiProperty()
  data!: Record<string, unknown>;
}

export class FinancialPreviewResponseDto {
  @ApiProperty()
  sheetType!: FinancialSheetType;

  @ApiProperty()
  totalRows!: number;

  @ApiProperty()
  validRows!: number;

  @ApiProperty()
  warningRows!: number;

  @ApiProperty()
  errorRows!: number;

  @ApiProperty({ type: [FinancialPreviewRowResult] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FinancialPreviewRowResult)
  rows!: FinancialPreviewRowResult[];

  @ApiProperty({ description: 'Calculated total disbursement / savings amount' })
  totalAmount!: number;
}

// ─── Financial Execute Request ────────────────────────────────────────────────

export class FinancialExecuteRequestDto {
  @ApiProperty({ enum: FinancialSheetType })
  @IsEnum(FinancialSheetType)
  sheetType!: FinancialSheetType;

  @ApiPropertyOptional({ description: 'Import batch ID from DataImportLog' })
  @IsOptional()
  @IsString()
  importBatchId?: string;
}

// ─── Financial Execute Response ───────────────────────────────────────────────

export class FinancialExecuteResponseDto {
  @ApiProperty()
  batchId!: string;

  @ApiProperty()
  sheetType!: FinancialSheetType;

  @ApiProperty()
  loansCreated!: number;

  @ApiProperty()
  repaymentsCreated!: number;

  @ApiProperty()
  savingsCreated!: number;

  @ApiProperty()
  welfareCollectionsCreated!: number;

  @ApiProperty()
  skipped!: number;

  @ApiProperty()
  errors!: number;

  @ApiPropertyOptional({ type: [Object] })
  errorDetails?: Array<{ row: number; reason: string }>;
}
