import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, Min, IsBoolean } from 'class-validator';
import { InterestType } from '@prisma/client';

export class CreateLoanProductDto {
  @ApiProperty({ example: 'Emergency Loan', description: 'Unique product name within the tenant' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ example: 'Short-term emergency loans for members' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 5000, description: 'Minimum loan amount in KES' })
  @IsNumber()
  @Min(100)
  minAmount!: number;

  @ApiProperty({ example: 500000, description: 'Maximum loan amount in KES' })
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
}
