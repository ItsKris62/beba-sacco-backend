import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { GuarantorNominationDto } from './member-apply-loan.dto';

/**
 * Used by both staff (POST /loans/apply) and members (POST /members/loans/apply).
 * When called from the member portal, memberId is derived from the JWT — not sent in body.
 */
export class ApplyLoanDto {
  @ApiProperty({ description: 'Member ID to apply the loan for (admin/staff use; ignored in member portal)' })
  @IsUUID()
  memberId!: string;

  @ApiProperty({ description: 'Loan product ID' })
  @IsUUID()
  loanProductId!: string;

  @ApiProperty({ description: 'Requested loan Amount in KES as a decimal-safe string at the API boundary as a decimal-safe string at the API boundary', example: 50000 })
  @IsNumber()
  @Min(100)
  principalAmount!: number;

  @ApiProperty({ description: 'Requested tenure in months', example: 12 })
  @IsInt()
  @Min(1)
  tenureMonths!: number;

  @ApiPropertyOptional({ description: 'Purpose of the loan', example: 'School fees for children' })
  @IsOptional()
  @IsString()
  purpose?: string;

  @ApiPropertyOptional({ description: 'Additional notes' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({
    description:
      'Proposed guarantors. Runtime product-rule validation enforces product.minGuarantors on the backend.',
    type: [GuarantorNominationDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GuarantorNominationDto)
  guarantors?: GuarantorNominationDto[];
}

export class MemberApplyLoanDto {
  @ApiProperty({ description: 'Loan product ID' })
  @IsUUID()
  loanProductId!: string;

  @ApiProperty({ description: 'Requested loan Amount in KES as a decimal-safe string at the API boundary as a decimal-safe string at the API boundary', example: 50000 })
  @IsNumber()
  @Min(100)
  principalAmount!: number;

  @ApiProperty({ description: 'Requested tenure in months', example: 12 })
  @IsInt()
  @Min(1)
  tenureMonths!: number;

  @ApiProperty({ description: 'Purpose of the loan', example: 'School fees for children' })
  @IsString()
  purpose!: string;

  @ApiPropertyOptional({ description: 'Additional notes' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({
    description:
      'Proposed guarantors. Runtime product-rule validation enforces product.minGuarantors on the backend.',
    type: [GuarantorNominationDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GuarantorNominationDto)
  guarantors?: GuarantorNominationDto[];
}

export function assertProductMinGuarantors(
  guarantors: GuarantorNominationDto[] | undefined,
  minGuarantors: number,
  productName: string,
): void {
  const guarantorCount = guarantors?.length ?? 0;
  if (guarantorCount < minGuarantors) {
    throw new Error(
      `${productName} requires at least ${minGuarantors} guarantor(s); received ${guarantorCount}.`,
    );
  }
}

