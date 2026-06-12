import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum AdminLoanStatus {
  PENDING_GUARANTORS = 'PENDING_GUARANTORS',
  PENDING_REVIEW = 'PENDING_REVIEW',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  REJECTED_GUARANTOR_DECLINE = 'REJECTED_GUARANTOR_DECLINE',
  // DISBURSED is routed to LoansService.disburse() at the controller level — it triggers the
  // full financial disbursement (FOSA credit + Serializable transaction), not a status-only update.
  DISBURSED = 'DISBURSED',
}

/**
 * DTO for PATCH /admin/loans/:id/status
 * Restricted to loan_officer and manager roles.
 */
export class UpdateLoanStatusDto {
  @ApiProperty({
    enum: AdminLoanStatus,
    description:
      'New status to transition the loan application to. ' +
      'DISBURSED triggers real financial disbursement (FOSA credit); all other values are workflow-only transitions.',
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
