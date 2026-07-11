import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MinLength, ValidateIf } from 'class-validator';

export enum LoanDecision {
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/**
 * DTO for PATCH /admin/loans/:id/decision — a thin, purpose-named alias over
 * LoanReviewService's APPROVE/DECLINE actions (see ReviewLoanDto). Disbursement
 * is deliberately NOT triggered by this endpoint: it stays a separate explicit
 * admin action (PATCH /admin/loans/:id/review with action=DISBURSE, or
 * PATCH /admin/loans/:id/status with status=DISBURSED) so loan officers retain
 * a distinct approve-then-disburse checkpoint rather than one action doing both.
 */
export class LoanDecisionDto {
  @ApiProperty({ enum: LoanDecision, example: LoanDecision.APPROVED })
  @IsEnum(LoanDecision)
  decision!: LoanDecision;

  @ApiPropertyOptional({
    description: 'Required (min 10 characters) when rejecting a loan; optional for approvals.',
    example: 'Debt-to-income ratio exceeds product policy after payslip review.',
  })
  @ValidateIf((dto: LoanDecisionDto) => dto.decision === LoanDecision.REJECTED)
  @IsString()
  @MinLength(10)
  comments?: string;
}
