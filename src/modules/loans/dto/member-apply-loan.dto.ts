import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * LoanGuarantor nomination DTO — included in the loan application
 * or submitted separately after draft creation.
 */
export class GuarantorNominationDto {
  @ApiProperty({ description: 'Member ID of the proposed guarantor', example: '550e8400-e29b-41d4-a716-446655440001' })
  @IsUUID()
  memberId!: string;

  @ApiProperty({ description: 'Amount this guarantor will guarantee in KES as a decimal-safe string at the API boundary', example: 25000 })
  @IsNumber()
  @Min(1)
  guaranteedAmount!: number;
}

/**
 * Member self-service loan application DTO.
 * Used exclusively by POST /members/loans/apply.
 * memberId is resolved from the JWT — never accepted from the client.
 */
export class MemberApplyLoanDto {
  @ApiProperty({ description: 'Loan product ID', example: '550e8400-e29b-41d4-a716-446655440000' })
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
  @IsOptional()
  @IsString()
  @MaxLength(500)
  purpose?: string;

  @ApiPropertyOptional({ description: 'Additional notes or context for the loan officer' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({ description: 'Proposed guarantors', type: [GuarantorNominationDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => GuarantorNominationDto)
  guarantors?: GuarantorNominationDto[];

  @ApiPropertyOptional({
    description: 'Guarantor member IDs resolved from POST /members/guarantors/lookup. Amount is split equally against required coverage.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsUUID('4', { each: true })
  guarantorIds?: string[];
}

/**
 * Member-owned guarantor request DTO.
 * Used by POST /members/loans/:id/guarantors/request for existing DRAFT or
 * PENDING_GUARANTORS applications.
 */
export class MemberRequestGuarantorsDto {
  @ApiPropertyOptional({ description: 'Guarantors with explicit pledged amounts', type: [GuarantorNominationDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => GuarantorNominationDto)
  guarantors?: GuarantorNominationDto[];

  @ApiPropertyOptional({
    description: 'Guarantor member IDs resolved from POST /members/guarantors/lookup. Remaining coverage is split equally.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsUUID('4', { each: true })
  guarantorIds?: string[];
}

/**
 * Staff-initiated loan application (on behalf of a member).
 * Includes guarantor nominations at creation time.
 */
export class StaffApplyLoanDto extends MemberApplyLoanDto {
  @ApiProperty({ description: 'Member ID to apply the loan for' })
  @IsUUID()
  memberId!: string;
}

