import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, Min, IsBoolean } from 'class-validator';
import { AccountType, InterestType } from '@prisma/client';

export class CreateLoanProductDto {
  @ApiProperty({ example: 'Emergency Loan', description: 'Unique product name within the tenant' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ example: 'Short-term emergency loans for members' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 5000, description: 'Minimum loan Amount in KES as a decimal-safe string at the API boundary as a decimal-safe string at the API boundary' })
  @IsNumber()
  @Min(100)
  minAmount!: number;

  @ApiProperty({ example: 500000, description: 'Maximum loan Amount in KES as a decimal-safe string at the API boundary as a decimal-safe string at the API boundary' })
  @IsNumber()
  @Min(100)
  maxAmount!: number;

  @ApiProperty({
    example: 0.12,
    description: 'Annual interest rate as a decimal (e.g., 0.12 = 12% p.a.)',
  })
  @IsNumber()
  @Min(0)
  @Max(2) // cap at 200% p.a. to catch data entry errors
  interestRate!: number;

  @ApiProperty({
    enum: InterestType,
    description: 'FLAT = interest on original principal; REDUCING_BALANCE = interest on outstanding balance',
    default: InterestType.REDUCING_BALANCE,
  })
  @IsEnum(InterestType)
  interestType!: InterestType;

  @ApiProperty({ example: 24, description: 'Maximum tenure in months' })
  @IsInt()
  @Min(1)
  @Max(360)
  maxTenureMonths!: number;

  @ApiPropertyOptional({
    example: 0.01,
    description: 'Processing fee as decimal of principal (e.g., 0.01 = 1%). Defaults to 0.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(0.5)
  processingFeeRate?: number;

  @ApiPropertyOptional({ enum: AccountType, description: 'Savings account type used for eligibility and guarantor holds' })
  @IsOptional()
  @IsEnum(AccountType)
  requiredAccountType?: AccountType;

  @ApiPropertyOptional({ example: 3, description: 'Maximum loan multiple against eligible savings' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(20)
  savingsMultiplier?: number;

  @ApiPropertyOptional({ example: 2, description: 'Minimum accepted guarantors required before review' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  minGuarantors?: number;

  @ApiPropertyOptional({ example: 3, description: 'Maximum guarantors a borrower may nominate' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  maxGuarantors?: number;

  @ApiPropertyOptional({
    example: 1,
    description: 'Minimum guarantor coverage ratio. 1.0 means guarantors must cover 100% of the loan amount.',
    default: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  guarantorCoverageRatio?: number;

  @ApiPropertyOptional({ example: false, description: 'Whether payslip upload is required for this product' })
  @IsOptional()
  @IsBoolean()
  requiresPayslip?: boolean;

  @ApiPropertyOptional({ example: 6, description: 'Minimum active membership age in months' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600)
  minActiveMonths?: number;

  @ApiPropertyOptional({
    example: 1,
    description:
      'Months after disbursement before first repayment is due (grace period). ' +
      'Interest accrues during this window but no cash collection occurs. ' +
      '0 = repayment starts the month following disbursement. Max 12.',
    default: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12, { message: 'Grace period cannot exceed 12 months' })
  gracePeriodMonths?: number;

  @ApiPropertyOptional({
    example: 14,
    description:
      'Arrears days a loan may accrue before guarantor recovery can be initiated. Default 14.',
    default: 14,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  gracePeriodDays?: number;

  @ApiPropertyOptional({ example: true, description: 'Whether members can select this product' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

