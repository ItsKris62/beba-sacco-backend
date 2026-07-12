import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBooleanString, IsEnum, IsIn, IsISO8601, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  AccountType,
  GLAccountType,
  GuarantorStatus,
  JournalEntryStatus,
  JournalEntryType,
  LoanStaging,
  LoanStatus,
  MpesaTxType,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';

export enum DashboardDrilldownSource {
  TRANSACTION = 'transaction',
  MPESA = 'mpesa',
  LOAN = 'loan',
  GUARANTOR = 'guarantor',
  MEMBER = 'member',
  JOURNAL = 'journal',
}

export class GuarantorCorrelationQueryDto {
  @ApiPropertyOptional({
    description: 'Return guarantors below the minimum sample-size threshold in a separate section',
    default: false,
  })
  @IsOptional()
  @IsBooleanString()
  includeBelowThreshold?: string;
}

export class DelinquencyTrendsQueryDto {
  @ApiPropertyOptional({ description: 'Snapshot start date, YYYY-MM-DD, inclusive' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Snapshot end date, YYYY-MM-DD, inclusive' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Loan product UUID' })
  @IsOptional()
  @IsString()
  loanProductId?: string;
}

export class DashboardDrilldownQueryDto {
  @ApiPropertyOptional({ enum: DashboardDrilldownSource })
  @IsEnum(DashboardDrilldownSource)
  source!: DashboardDrilldownSource;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: TransactionType })
  @IsOptional()
  @IsEnum(TransactionType)
  type?: TransactionType;

  @ApiPropertyOptional({ enum: TransactionStatus })
  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;

  @ApiPropertyOptional({ enum: MpesaTxType })
  @IsOptional()
  @IsEnum(MpesaTxType)
  mpesaType?: MpesaTxType;

  @ApiPropertyOptional({ enum: AccountType })
  @IsOptional()
  @IsEnum(AccountType)
  accountType?: AccountType;

  @ApiPropertyOptional({ enum: LoanStatus })
  @IsOptional()
  @IsEnum(LoanStatus)
  loanStatus?: LoanStatus;

  @ApiPropertyOptional({ enum: LoanStaging })
  @IsOptional()
  @IsEnum(LoanStaging)
  loanStaging?: LoanStaging;

  @ApiPropertyOptional({ enum: GuarantorStatus })
  @IsOptional()
  @IsEnum(GuarantorStatus)
  guarantorStatus?: GuarantorStatus;

  @ApiPropertyOptional({ enum: JournalEntryType })
  @IsOptional()
  @IsEnum(JournalEntryType)
  journalType?: JournalEntryType;

  @ApiPropertyOptional({ enum: JournalEntryStatus })
  @IsOptional()
  @IsEnum(JournalEntryStatus)
  journalStatus?: JournalEntryStatus;

  @ApiPropertyOptional({ enum: GLAccountType, description: 'Only journal entries with a credit posting to this GL account type' })
  @IsOptional()
  @IsEnum(GLAccountType)
  creditAccountType?: GLAccountType;

  @ApiPropertyOptional({ description: 'ISO 8601 start date/time, inclusive' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO 8601 end date/time, inclusive' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Loan product UUID' })
  @IsOptional()
  @IsString()
  loanProductId?: string;

  @ApiPropertyOptional({ description: 'Loan date field to apply from/to filters against', enum: ['createdAt', 'appliedAt', 'disbursedAt'] })
  @IsOptional()
  @IsIn(['createdAt', 'appliedAt', 'disbursedAt'])
  loanDateField?: 'createdAt' | 'appliedAt' | 'disbursedAt';

  @ApiPropertyOptional({ description: 'Snapshot date, YYYY-MM-DD. When supplied with source=loan, loan rows are read from LoanArrearsSnapshot.' })
  @IsOptional()
  @IsISO8601()
  snapshotDate?: string;

  @ApiPropertyOptional({ description: 'Search reference, account, member, or loan number' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Aging bucket key: current, arrears, days1to30, days31to60, days61to90, days90Plus, par30' })
  @IsOptional()
  @IsString()
  agingBucket?: string;

  @ApiPropertyOptional({ description: 'Guarantor coverage bucket: full, partial, none' })
  @IsOptional()
  @IsString()
  coverage?: string;

  @ApiPropertyOptional({ description: 'Membership bucket: active, pending, other' })
  @IsOptional()
  @IsString()
  membershipSegment?: string;
}
