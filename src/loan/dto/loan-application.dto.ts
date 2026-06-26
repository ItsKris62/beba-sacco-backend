import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class ApplyForLoanDto {
  @ApiProperty()
  @IsUUID()
  loanId!: string;
}

export class ApproveLoanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class RejectLoanDto {
  @ApiProperty()
  @IsString()
  rejectionReason!: string;
}

export class CreateLoanApplicationDto {
  @ApiProperty()
  @IsUUID()
  memberId!: string;

  @ApiProperty()
  @IsUUID()
  loanProductId!: string;

  @ApiProperty()
  @IsNumber()
  @Min(1)
  principalAmount!: number;

  @ApiProperty()
  @IsNumber()
  @Min(1)
  tenureMonths!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  purpose?: string;
}
