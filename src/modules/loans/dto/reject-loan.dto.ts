import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RejectLoanDto {
  @ApiProperty({ description: 'Reason for rejection (required for audit trail)', example: 'Insufficient guarantor coverage' })
  @IsString()
  @MinLength(10, { message: 'Rejection reason must be at least 10 characters' })
  reason!: string;
}
