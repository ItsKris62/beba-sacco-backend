import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

/** Used by members applying for their own loans via the member portal */
export class MemberLoanApplyDto {
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
