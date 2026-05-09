import {
  Controller, Get, Patch, Post, Body, Param, Query, Req,
  HttpCode, HttpStatus, ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiResponse, ApiHeader, ApiParam, ApiQuery, ApiBody, ApiProperty, ApiPropertyOptional,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { IsEnum, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Decimal } from 'decimal.js';
import { Request } from 'express';
import { LoanApplicationService } from './loan-application.service';
import { LoansService } from './loans.service';
import { LoanAdminService } from './loan-admin.service';
import { LoanReviewService } from './loan-review.service';
import { LoanRecoveryService } from './loan-recovery.service';
import { GuarantorResponseService, GuarantorWorkflowAction } from '../../loans/guarantor-response.service';
import { UpdateLoanStatusDto, AdminLoanStatus } from './dto/update-loan-status.dto';
import { GetAdminLoansQueryDto } from './dto/get-admin-loans-query.dto';
import { ReviewLoanDto } from './dto/review-loan.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

export class RecoverLoanDto {
  @ApiProperty({ description: 'Default amount to recover from accepted guarantors', example: 10000 })
  @IsNumber()
  @Min(1)
  defaultAmount!: number;

  @ApiPropertyOptional({ description: 'Recovery notes for audit context', example: '90-day default recovery' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

enum AdminGuarantorDecision {
  ACCEPT = 'ACCEPT',
  DECLINE = 'DECLINE',
}

class AdminGuarantorStatusDto {
  @ApiProperty({ enum: AdminGuarantorDecision, example: AdminGuarantorDecision.ACCEPT })
  @IsEnum(AdminGuarantorDecision)
  action!: AdminGuarantorDecision;

  @ApiPropertyOptional({ description: 'Decision note for audit trail', example: 'Confirmed by phone' })
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
@Roles(UserRole.MANAGER, UserRole.TENANT_ADMIN)
@Controller('admin')
export class LoanAdminController {
  constructor(
    private readonly loanApp: LoanApplicationService,
    private readonly loans: LoansService,
    private readonly loanAdmin: LoanAdminService,
    private readonly loanReview: LoanReviewService,
    private readonly loanRecovery: LoanRecoveryService,
    private readonly guarantorResponses: GuarantorResponseService,
  ) {}

  // ─── LOAN LIST ───────────────────────────────────────────────────────────────

  @Get('loans')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List all loans (admin)',
    description:
      'Paginated list of all loans in the tenant. Filterable by status, product, and member. ' +
      'Returns guarantor coverage (% of principal covered by accepted guarantors) and ' +
      'accruedInterest (stubbed at 0 until Tier 3 schema migration).',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT','PENDING_GUARANTORS','UNDER_REVIEW','APPROVED','ACTIVE','FULLY_PAID','REJECTED','DEFAULTED'] })
  @ApiQuery({ name: 'loanProductId', required: false, type: String })
  @ApiQuery({ name: 'memberId', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Paginated loan list',
    schema: {
      example: {
        data: [
          {
            id: 'uuid',
            loanNumber: 'LN-2026-000001',
            memberName: 'Jane Doe',
            productId: 'uuid',
            status: 'ACTIVE',
            principalAmount: 50000,
            outstandingBalance: 42000,
            accruedInterest: 0,
            disbursedAt: '2026-05-01T10:00:00.000Z',
            guarantorCoverage: 100,
          },
        ],
        meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
      },
    },
  })
  async listLoans(
    @Query() query: GetAdminLoansQueryDto,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.loanAdmin.findAll(tenant.id, query);
  }

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

  // ─── LOAN STATUS TRANSITION ──────────────────────────────────────────────────

  @Patch('loans/:id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update loan application status',
    description:
      '**Workflow transitions** (PENDING_GUARANTORS, UNDER_REVIEW, APPROVED, REJECTED): ' +
      'update the loan status only, no financial operations.\n\n' +
      '**DISBURSED**: triggers real financial disbursement — credits the member\'s FOSA ' +
      'account with the principal amount inside a Serializable transaction. ' +
      'Idempotent: returns 409 if the loan is already ACTIVE (already disbursed).\n\n' +
      'Valid workflow transitions:\n' +
      '- `DRAFT → PENDING_GUARANTORS | REJECTED`\n' +
      '- `PENDING_GUARANTORS → UNDER_REVIEW | REJECTED`\n' +
      '- `UNDER_REVIEW → APPROVED | REJECTED`\n' +
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
        disbursedAt: '2026-05-08T10:00:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid status transition or missing rejection reason' })
  @ApiResponse({ status: 403, description: 'Insufficient role privileges' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  @ApiResponse({ status: 409, description: 'Loan already disbursed (idempotent DISBURSED call)' })
  @ApiResponse({ status: 422, description: 'Member has no active FOSA account or KYC not approved' })
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
      'Idempotent admin review endpoint. DISBURSE requires Idempotency-Key and performs ledger updates in a Serializable transaction.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Required for DISBURSE. Recommended for all review mutations.',
  })
  @ApiParam({ name: 'id', description: 'Loan UUID' })
  @ApiResponse({ status: 200, description: 'Loan review action processed' })
  @ApiResponse({ status: 400, description: 'Invalid action or loan state' })
  @ApiResponse({ status: 409, description: 'Duplicate request processing' })
  async reviewLoan(
    @Param('id', ParseUUIDPipe) loanId: string,
    @Body() dto: ReviewLoanDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    return this.loanReview.process(loanId, dto, tenant.id, actor.id, req.ip, idempotencyKey);
  }

  @Patch('loans/:loanId/guarantors/:guarantorId/status')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Accept or decline a pending guarantor on behalf of a member',
    description: 'Manager-only override. Applies the same loan state transitions and writes chained audit logs.',
  })
  @ApiParam({ name: 'loanId', description: 'Loan UUID' })
  @ApiParam({ name: 'guarantorId', description: 'LoanGuarantor UUID or guarantor member UUID' })
  @ApiBody({ type: AdminGuarantorStatusDto })
  @ApiResponse({ status: 200, description: 'Guarantor decision applied' })
  @ApiResponse({ status: 403, description: 'Manager role required' })
  async updateGuarantorStatus(
    @Param('loanId', ParseUUIDPipe) loanId: string,
    @Param('guarantorId', ParseUUIDPipe) guarantorId: string,
    @Body() dto: AdminGuarantorStatusDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.guarantorResponses.adminOverride(
      loanId,
      guarantorId,
      { action: dto.action as GuarantorWorkflowAction, notes: dto.notes },
      tenant.id,
      actor.id,
      req,
    );
  }

  @Patch('loans/:id/recover')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Recover defaulted loan amount from accepted guarantors',
    description:
      'Deducts proportionally from accepted guarantor savings holds, updates recoveredAmount, and writes chained SASRA audit logs.',
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
    description: 'Recovery summary',
    schema: {
      example: {
        recoverySummary: {
          totalRecovered: '10000',
          remainingDebt: '0',
        },
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
    return this.loanRecovery.recoverFromGuarantors(
      loanId,
      tenant.id,
      new Decimal(dto.defaultAmount),
      actor.id,
    );
  }
}
