import {
  Controller,
  ForbiddenException,
  Get,
  Patch,
  Post,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiSecurity,
  ApiOperation,
  ApiResponse,
  ApiHeader,
  ApiParam,
  ApiQuery,
  ApiBody,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { LoanStatus, UserRole } from '@prisma/client';
import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Decimal } from 'decimal.js';
import { Request } from 'express';
import { LoanApplicationService } from './loan-application.service';
import { LoansService } from './loans.service';
import { LoanReviewService } from './loan-review.service';
import { LoanRecoveryService } from './loan-recovery.service';
import { UpdateLoanStatusDto, AdminLoanStatus } from './dto/update-loan-status.dto';
import { ReviewLoanAction, ReviewLoanDto } from './dto/review-loan.dto';
import { LoanDecisionDto, LoanDecision } from './dto/loan-decision.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { LoanStateGuard } from './decorators/loan-state-guard.decorator';
import { LoanStateTransitionGuard } from './guards/loan-state-transition.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

export class RecoverLoanDto {
  @ApiProperty({
    description: 'Default amount to recover from accepted guarantors',
    example: 10000,
  })
  @IsNumber()
  @Min(1)
  defaultAmount!: number;

  @ApiPropertyOptional({
    description: 'Recovery notes for audit context',
    example: '90-day default recovery',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/**
 * Admin Loan Controller
 *
 * Restricted to MANAGER and TENANT_ADMIN roles.
 * Provides loan oversight, guarantor exposure checks, and status management.
 *
 * DISBURSED transition is specially handled: it routes to LoansService.disburse()
 * which credits the member's FOSA account inside a Serializable transaction.
 * All other transitions go through LoanApplicationService.updateStatus() (workflow-only).
 */
@ApiTags('Admin — Loans')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Roles(UserRole.LOAN_OFFICER, UserRole.MANAGER, UserRole.TENANT_ADMIN)
@Controller('admin')
export class LoanAdminController {
  constructor(
    private readonly loanApp: LoanApplicationService,
    private readonly loans: LoansService,
    private readonly loanReview: LoanReviewService,
    private readonly loanRecovery: LoanRecoveryService,
  ) {}

  // ─── GUARANTOR EXPOSURE ─────────────────────────────────────────────────────

  @Get('members/:id/guarantor-exposure')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get guarantor exposure for a member',
    description:
      'Returns total guarantee exposure, active guarantees, and remaining capacity. ' +
      'Used by loan officers to verify guarantor eligibility before invitation.',
  })
  @ApiParam({ name: 'id', description: 'Member UUID' })
  @ApiResponse({
    status: 200,
    description: 'LoanGuarantor exposure data',
    schema: {
      example: {
        memberId: 'uuid',
        memberNumber: 'M-000001',
        memberName: 'Jane Doe',
        maxConcurrentGuarantees: 3,
        currentGuaranteeCount: 1,
        totalGuaranteedAmount: 50000,
        remainingCapacity: 2,
        canGuarantee: true,
        activeGuarantees: [],
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Member not found' })
  async getGuarantorExposure(
    @Param('id', ParseUUIDPipe) memberId: string,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.loanApp.getGuarantorExposure(memberId, tenant.id);
  }

  // ─── PENDING APPROVAL QUEUE ─────────────────────────────────────────────────

  @Get('loans/pending')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List loans awaiting approval (PENDING_APPROVAL)',
    description:
      'Loans that have cleared guarantor consent and are awaiting a loan-officer/manager ' +
      'decision. Each entry includes member contact details, loan product terms, and the ' +
      'full list of ACCEPTED guarantors (name, guaranteed amount, response time) so a ' +
      'decision can be made without a second round-trip.',
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async pendingApprovals(
    @CurrentTenant() tenant: Tenant,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: number,
  ) {
    return this.loans.getPendingApprovalQueue(tenant.id, { cursor, limit });
  }

  // ─── APPROVE / REJECT DECISION ───────────────────────────────────────────────

  @Patch('loans/:id/decision')
  @Roles(UserRole.LOAN_OFFICER, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve or reject a loan in PENDING_APPROVAL',
    description:
      'Thin alias over the same hardened approve/decline path as PATCH /admin/loans/:id/review ' +
      '(dual-approval initialization, guarantor-hold release on rejection). Does NOT trigger ' +
      'disbursement — approving here only moves the loan to APPROVED. Disbursement to the ' +
      "member's FOSA account remains a separate explicit action: PATCH /admin/loans/:id/review " +
      'with action=DISBURSE, or PATCH /admin/loans/:id/status with status=DISBURSED. Direct ' +
      "M-Pesa/B2C disbursement is not supported — see LoansService.disburse()'s disburseToMpesa guard.",
  })
  @ApiParam({ name: 'id', description: 'Loan UUID' })
  @ApiBody({
    type: LoanDecisionDto,
    examples: {
      approve: { summary: 'Approve', value: { decision: 'APPROVED' } },
      reject: {
        summary: 'Reject',
        value: { decision: 'REJECTED', comments: 'Debt-to-income ratio exceeds product policy.' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Decision recorded' })
  @ApiResponse({ status: 400, description: 'Invalid decision, or missing rejection comments' })
  @ApiResponse({ status: 403, description: 'Insufficient role privileges' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  @UseGuards(LoanStateTransitionGuard)
  @LoanStateGuard({
    loanIdParam: 'id',
    targetStatusBodyField: 'decision',
    targetStatusMap: {
      [LoanDecision.APPROVED]: LoanStatus.APPROVED,
      [LoanDecision.REJECTED]: LoanStatus.REJECTED,
    },
  })
  async decideLoan(
    @Param('id', ParseUUIDPipe) loanId: string,
    @Body() dto: LoanDecisionDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const reviewDto: ReviewLoanDto = {
      action: dto.decision === LoanDecision.APPROVED ? ReviewLoanAction.APPROVE : ReviewLoanAction.DECLINE,
      reason: dto.comments,
    };
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    return this.loanReview.process(loanId, reviewDto, tenant.id, actor.id, req.ip, idempotencyKey);
  }

  // ─── LOAN STATUS TRANSITION ──────────────────────────────────────────────────

  @Patch('loans/:id/status')
  @Roles(UserRole.LOAN_OFFICER, UserRole.MANAGER, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update loan application status',
    description:
      '**Workflow transitions** (PENDING_GUARANTORS, PENDING_REVIEW): update the loan status only.\n\n' +
      '**APPROVED / REJECTED**: routed through LoansService.approve()/reject() so dual-approval ' +
      'initialization and guarantor hold release logic are enforced.\n\n' +
      "**DISBURSED**: triggers real financial disbursement — credits the member's FOSA " +
      'account with netDisbursement = principalAmount - processingFee inside a Serializable transaction. ' +
      'The ledger stores a gross LOAN_DISBURSEMENT credit and a separate FEE_CHARGE debit. ' +
      'Idempotent: returns 409 if the loan is already ACTIVE (already disbursed).\n\n' +
      'Valid workflow transitions:\n' +
      '- `DRAFT → PENDING_GUARANTORS | REJECTED`\n' +
      '- `PENDING_GUARANTORS → PENDING_REVIEW | REJECTED`\n' +
      '- `PENDING_REVIEW → APPROVED | REJECTED`\n' +
      '- `APPROVED → DISBURSED` (triggers FOSA credit → loan becomes ACTIVE)\n\n' +
      'Reason is required when transitioning to REJECTED.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Idempotency key for safe retries. Has effect only for the DISBURSED transition.',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ApiParam({ name: 'id', description: 'Loan UUID' })
  @ApiResponse({
    status: 200,
    description: 'Status updated (workflow) or loan disbursed (DISBURSED)',
    schema: {
      example: {
        id: 'uuid',
        loanNumber: 'LN-2026-000001',
        status: 'ACTIVE',
        principalAmount: '50000.0000',
        processingFee: '1000.0000',
        netDisbursement: 49000,
        newBalance: 59000,
        disbursedAt: '2026-05-08T10:00:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid status transition or missing rejection reason',
  })
  @ApiResponse({ status: 403, description: 'Insufficient role privileges' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  @ApiResponse({ status: 409, description: 'Loan already disbursed (idempotent DISBURSED call)' })
  @ApiResponse({
    status: 422,
    description: 'Member has no active FOSA account or KYC not approved',
  })
  @UseGuards(LoanStateTransitionGuard)
  @LoanStateGuard({ loanIdParam: 'id', targetStatusBodyField: 'status' })
  async updateStatus(
    @Param('id', ParseUUIDPipe) loanId: string,
    @Body() dto: UpdateLoanStatusDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    // DISBURSED requires real money movement — route to LoansService.disburse() which
    // performs a Serializable transaction crediting the member's FOSA account.
    // All other transitions are workflow-only and go through LoanApplicationService.
    if (dto.status === AdminLoanStatus.DISBURSED) {
      this.assertManagerForDisbursement(actor);
      return this.loans.disburse(loanId, tenant.id, actor.id, req.ip);
    }
    return this.loanApp.updateStatus(loanId, dto, tenant.id, actor, req);
  }

  @Patch('loans/:id/review')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.LOAN_OFFICER, UserRole.MANAGER, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Review, decline, approve, or disburse a loan',
    description:
      'Idempotent admin review endpoint. DISBURSE requires Idempotency-Key and posts the gross loan disbursement plus processing-fee ledger entries in a Serializable transaction. The member FOSA balance increases by principal minus processing fee.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Required for DISBURSE. Recommended for all review mutations.',
  })
  @ApiParam({ name: 'id', description: 'Loan UUID' })
  @ApiResponse({
    status: 200,
    description: 'Loan review action processed',
    schema: {
      example: {
        loan: {
          id: 'uuid',
          status: 'ACTIVE',
          principalAmount: '50000.0000',
          processingFee: '1000.0000',
        },
        principalAmount: 50000,
        processingFee: 1000,
        netDisbursement: 49000,
        newBalance: 59000,
        disbursement_status: 'COMPLETED',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid action or loan state' })
  @ApiResponse({ status: 409, description: 'Duplicate request processing' })
  @UseGuards(LoanStateTransitionGuard)
  @LoanStateGuard({
    loanIdParam: 'id',
    targetStatusBodyField: 'action',
    targetStatusMap: {
      [ReviewLoanAction.APPROVE]: LoanStatus.APPROVED,
      [ReviewLoanAction.DECLINE]: LoanStatus.REJECTED,
      [ReviewLoanAction.DISBURSE]: LoanStatus.DISBURSED,
    },
  })
  async reviewLoan(
    @Param('id', ParseUUIDPipe) loanId: string,
    @Body() dto: ReviewLoanDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    if (dto.action === ReviewLoanAction.DISBURSE) {
      this.assertManagerForDisbursement(actor);
    }
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    return this.loanReview.process(loanId, dto, tenant.id, actor.id, req.ip, idempotencyKey);
  }

  // ─── EXPLICIT DISBURSE ENDPOINT (Maker-Checker) ──────────────────────────────

  @Post('loans/:id/disburse')
  @Roles(UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Disburse an APPROVED loan to the member\'s FOSA account',
    description:
      'Maker-checker: LOAN_OFFICER approves via PATCH /admin/loans/:id/decision, only MANAGER may ' +
      'disburse. Delegates entirely to LoansService.disburse() — verifies loan status is APPROVED and ' +
      "member KYC is APPROVED, then atomically (Serializable transaction) credits the member's FOSA " +
      'account via LedgerService, charges the processing fee, moves the loan to ACTIVE, and generates ' +
      'the LoanRepayment schedule. Idempotent: replaying against an already-ACTIVE loan returns the ' +
      'original disbursement result instead of re-running or erroring.',
  })
  @ApiParam({ name: 'id', description: 'Loan UUID' })
  @ApiResponse({ status: 200, description: 'Loan disbursed (or idempotent replay of a prior disbursement)' })
  @ApiResponse({ status: 400, description: 'Loan is not APPROVED, or KYC is not APPROVED' })
  @ApiResponse({ status: 403, description: 'Only MANAGER may disburse (maker-checker)' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  @ApiResponse({ status: 409, description: 'Loan already disbursed — ledger inconsistency if no matching transaction' })
  async disburseLoan(
    @Param('id', ParseUUIDPipe) loanId: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.loans.disburse(loanId, tenant.id, actor.id, req.ip);
  }

  /**
   * Maker-checker guard for the DISBURSE action reachable through the two legacy
   * multi-action endpoints (status=DISBURSED, action=DISBURSE). Both endpoints'
   * class/method-level @Roles() still allow LOAN_OFFICER for their other actions
   * (workflow transitions, APPROVE/DECLINE) — this runtime check narrows only the
   * money-moving branch to MANAGER, matching POST /admin/loans/:id/disburse.
   * SUPER_ADMIN bypasses RBACGuard entirely upstream, so it never reaches here
   * with a non-MANAGER role that should have been rejected.
   */
  private assertManagerForDisbursement(actor: AuthenticatedUser): void {
    if (actor.role !== UserRole.MANAGER && actor.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only MANAGER may disburse a loan (maker-checker: the approving LOAN_OFFICER cannot also disburse)',
      );
    }
  }

  @Patch('loans/:id/recover')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Start delayed guarantor recovery workflow',
    description:
      'Queues a notice of intent to accepted guarantors and schedules the actual debit 7 days later. The delayed job re-checks default status before deducting.',
  })
  @ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
  @ApiParam({ name: 'id', description: 'Loan UUID' })
  @ApiBody({
    type: RecoverLoanDto,
    examples: {
      recovery: {
        summary: 'Recover KES 10000 from guarantor holds',
        value: { defaultAmount: 10000, notes: '90-day default recovery' },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Recovery notice job queued',
    schema: {
      example: {
        jobId: 'guarantor-recovery-notice.tenant-id.loan-id',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid recovery request',
    schema: {
      examples: {
        invalidAmount: {
          value: {
            statusCode: 400,
            message: 'INVALID_DEFAULT_AMOUNT: defaultAmount must be greater than zero',
          },
        },
        noAcceptedGuarantors: {
          value: {
            statusCode: 400,
            message: 'NO_ACCEPTED_GUARANTORS: loan has no accepted guarantors for recovery',
          },
        },
      },
    },
  })
  @ApiResponse({ status: 403, description: 'Only managers can perform guarantor recovery' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  async recoverLoan(
    @Param('id', ParseUUIDPipe) loanId: string,
    @Body() dto: RecoverLoanDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loanRecovery.initiateGuarantorRecovery(
      loanId,
      tenant.id,
      new Decimal(dto.defaultAmount),
      actor.id,
    );
  }
}
