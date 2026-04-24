import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  Min,
  Max,
  Matches,
  MaxLength,
} from 'class-validator';

export enum DepositPurpose {
  SAVINGS = 'SAVINGS',       // Credit member's BOSA/FOSA savings account
  LOAN_REPAYMENT = 'LOAN_REPAYMENT', // Apply payment against active loan
}

export class MemberDepositDto {
  @ApiProperty({
    example: '254712345678',
    description: 'Customer phone in E.164 format (2547XXXXXXXXX or 2541XXXXXXXXX)',
  })
  @IsString()
  @Matches(/^254[0-9]{9}$/, { message: 'Phone must be in format 254XXXXXXXXX (E.164)' })
  phoneNumber!: string;

  @ApiProperty({
    example: 500,
    description: 'Amount in KES (integer, min 10, max 300000 per Daraja limits)',
  })
  @IsNumber()
  @Min(10, { message: 'Minimum deposit amount is KES 10' })
  @Max(300000, { message: 'Maximum single deposit is KES 300,000 per Daraja limits' })
  amount!: number;

  @ApiProperty({
    enum: DepositPurpose,
    example: DepositPurpose.SAVINGS,
    description:
      'SAVINGS → credited to the account number in accountRef. ' +
      'LOAN_REPAYMENT → applied to the loan number in accountRef.',
  })
  @IsEnum(DepositPurpose)
  purpose!: DepositPurpose;

  @ApiProperty({
    example: 'ACC-FOSA-000042',
    description:
      'For SAVINGS: member account number. ' +
      'For LOAN_REPAYMENT: loan number (LN-2025-000001).',
  })
  @IsString()
  @MaxLength(30)
  accountRef!: string;

  @ApiPropertyOptional({
    example: 'School fees deposit',
    description: 'Optional note shown on the STK Push screen (max 13 chars due to Daraja limit)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(13)
  note?: string;
}
