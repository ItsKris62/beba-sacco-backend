import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MinLength, ValidateIf } from 'class-validator';

export enum ReviewLoanAction {
  APPROVE = 'APPROVE',
  DECLINE = 'DECLINE',
  DISBURSE = 'DISBURSE',
}

export class ReviewLoanDto {
  @ApiProperty({ enum: ReviewLoanAction })
  @IsEnum(ReviewLoanAction)
  action!: ReviewLoanAction;

  @ApiPropertyOptional({ description: 'Required when declining a loan.' })
  @ValidateIf((dto: ReviewLoanDto) => dto.action === ReviewLoanAction.DECLINE)
  @IsString()
  @MinLength(10)
  reason?: string;

  @ApiPropertyOptional({ description: 'Optional approval or disbursement note.' })
  @IsOptional()
  @IsString()
  comment?: string;
}
