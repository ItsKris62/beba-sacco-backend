import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

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

  @ApiProperty({ description: 'Requested loan amount in KES', example: 50000 })
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
}

export class MemberApplyLoanDto {
  @ApiProperty({ description: 'Loan product ID' })
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
  purpose!: string;

  @ApiPropertyOptional({ description: 'Additional notes' })
  @IsOptional()
  @IsString()
  notes?: string;
}
