import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class ApplyLoanDto {
  @ApiProperty({ description: 'Member ID to apply the loan for' })
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

  @ApiPropertyOptional({ description: 'Purpose or additional notes for the loan application' })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class RequestGuarantorDto {
  @ApiProperty()
  @IsString()
  loanId!: string;

  @ApiProperty()
  @IsString()
  guarantorId!: string;

  @ApiProperty({ description: 'Amount to be guaranteed in KES' })
  @IsNumber()
  @Min(1000)
  guaranteedAmount!: number;
}
