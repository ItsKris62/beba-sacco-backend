import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsString, IsUUID, Min, MaxLength } from 'class-validator';

/**
 * LoanGuarantor nomination DTO — included in the loan application
 * or submitted separately after draft creation.
 */
export class GuarantorNominationDto {
  @ApiProperty({ description: 'Member ID of the proposed guarantor', example: '550e8400-e29b-41d4-a716-446655440001' })
  @IsUUID()
  memberId!: string;

  @ApiProperty({ description: 'Amount this guarantor will guarantee', example: 25000 })
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

  @ApiProperty({ description: 'Requested loan amount in KES', example: 50000 })
  @IsNumber()
  @Min(100)
  principalAmount!: number;

  @ApiProperty({ description: 'Requested tenure in months', example: 12 })
  @IsInt()
  @Min(1)
  tenureMonths!: number;

  @ApiProperty({ description: 'Purpose of the loan', example: 'School fees for children' })
  @IsString()
  @MaxLength(500)
  purpose!: string;

  @ApiPropertyOptional({ description: 'Additional notes or context for the loan officer' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({ description: 'Proposed guarantors', type: [GuarantorNominationDto] })
  @IsOptional()
  guarantors?: GuarantorNominationDto[];
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
