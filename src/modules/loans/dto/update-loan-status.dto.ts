import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum AdminLoanStatus {
  PENDING_GUARANTORS = 'PENDING_GUARANTORS',
  UNDER_REVIEW = 'UNDER_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/**
 * DTO for PATCH /admin/loans/:id/status
 * Restricted to loan_officer and manager roles.
 */
export class UpdateLoanStatusDto {
  @ApiProperty({
    enum: AdminLoanStatus,
    description: 'New status to transition the loan application to',
    example: 'APPROVED',
  })
  @IsEnum(AdminLoanStatus)
  status!: AdminLoanStatus;

  @ApiPropertyOptional({
    description: 'Reason for the status change (required for REJECTED)',
    example: 'Insufficient guarantor coverage after 72h expiry',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
