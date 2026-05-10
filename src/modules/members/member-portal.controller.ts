import {
  Controller, Get, Post, Patch, Body, Param, Query, ParseUUIDPipe,
  BadRequestException, HttpCode, HttpStatus, Req, UseGuards, ForbiddenException, Res,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiResponse, ApiQuery, ApiHeader, ApiParam,
} from '@nestjs/swagger';
import { GuarantorStatus, LoanStatus, UserRole } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { Request, Response } from 'express';
import { MembersService } from './members.service';
import { MemberPortalService } from './member-portal.service';
import { LoansService } from '../loans/loans.service';
import { LoanApplicationService } from '../loans/loan-application.service';
import { MpesaService } from '../mpesa/mpesa.service';
import { StatementService } from '../statements/statement.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';
import { MemberDepositDto } from '../mpesa/dto/deposit-request.dto';
import { MemberApplyLoanDto, MemberRequestGuarantorsDto } from '../loans/dto/member-apply-loan.dto';
import { GuarantorConsentResponseDto } from '../loans/dto/guarantor-consent-response.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { MemberDashboardDto } from '../../common/dto/member-dashboard.dto';

/**
 * Member Portal Controller
 *
 * All endpoints are scoped to the authenticated member's own data.
 * The memberId is resolved from the JWT token (req.user.id → Member.userId lookup).
 *
 * RBAC: All endpoints require MEMBER role (or higher, via hierarchy).
 */
@ApiTags('Member Portal')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Roles(UserRole.MEMBER, UserRole.LOAN_OFFICER)
@Controller('members')
export class MemberPortalController {
  constructor(
    private readonly members: MembersService,
    private readonly portal: MemberPortalService,
    private readonly loans: LoansService,
    private readonly loanApp: LoanApplicationService,
    private readonly mpesa: MpesaService,
    private readonly statements: StatementService,
    private readonly prisma: PrismaService,
    private readonly dashboardService: DashboardService,
  ) {}

  /** Resolve memberId from the authenticated user's id */
  private async resolveMemberId(userId: string, tenantId: string): Promise<string> {
    const member = await this.prisma.member.findFirst({
      where: { userId, tenantId },
      select: { id: true },
    });
    if (!member) throw new Error('Member profile not found');
    return member.id;
  }

  // ─── DASHBOARD ─────────────────────────────────────────────────────────────

  @Get('dashboard')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Member personal dashboard',
    description: 'Returns balances, active loans, and pending deposits for the authenticated member.',
  })
  @ApiResponse({ status: 200, description: 'Dashboard data', type: MemberDashboardDto })
  @ApiResponse({ status: 206, description: 'Partial dashboard data', type: MemberDashboardDto })
  async getDashboard(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.dashboardService.getMemberDashboard(
      tenant.id,
      user.id,
      (req.headers['x-correlation-id'] as string | undefined) ??
        (req.headers['x-request-id'] as string | undefined),
    );
    if (result.partial) res.status(HttpStatus.PARTIAL_CONTENT);
    return result.data;
  }

  // ─── FOSA STATEMENT ────────────────────────────────────────────────────────

  @Get('accounts/fosa/statement')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'FOSA account statement',
    description: 'Paginated, date-filtered FOSA statement for the authenticated member.',
  })
  @ApiQuery({ name: 'periodFrom', required: false, example: '2024-01-01' })
  @ApiQuery({ name: 'periodTo', required: false, example: '2024-12-31' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'FOSA statement' })
  async getFosaStatement(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Query('periodFrom') periodFrom?: string,
    @Query('periodTo') periodTo?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const memberId = await this.resolveMemberId(user.id, tenant.id);
    return this.statements.getFosaStatement(tenant.id, user.id, memberId, periodFrom, periodTo);
  }

  // ─── LOAN SELF-APPLICATION ─────────────────────────────────────────────────

  @Post('loans/apply')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Apply for a loan (member self-service)',
    description:
      'Members apply for Development or Jipange loan products. ' +
      'memberId is resolved from the JWT — never accepted from the request body. ' +
      'Publishes LoanApplied domain event to BullMQ. ' +
      'Supply Idempotency-Key header to prevent duplicate submissions on retry.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Client-generated UUID to make this request idempotent (24 h TTL)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ApiResponse({ status: 201, description: 'Loan application created (DRAFT)' })
  @ApiResponse({ status: 400, description: 'Validation error or product constraint violated' })
  @ApiResponse({ status: 409, description: 'Idempotency key already in use (duplicate request)' })
  @ApiResponse({ status: 422, description: 'Eligibility not met: KYC pending, deposit limit, or defaulted loan' })
  async applyLoan(
    @Body() dto: MemberApplyLoanDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    const memberId = await this.resolveMemberId(user.id, tenant.id);
    const idempotencyKey =
      (req.headers['x-idempotency-key'] as string | undefined) ??
      (req.headers['idempotency-key'] as string | undefined);
    return this.loanApp.memberApply(dto, tenant.id, memberId, user.id, req, idempotencyKey);
  }

  // ─── LOAN DETAIL ──────────────────────────────────────────────────────────

  @Get('loans/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get loan detail (member self-service)',
    description:
      'Returns full loan detail for a loan owned by the authenticated member: ' +
      'outstanding balance, accrued interest (stubbed at 0 until Tier 3), totalAmountDue, ' +
      'last 5 transactions, and an analytically generated repayment schedule stub.',
  })
  @ApiParam({ name: 'id', description: 'Loan UUID' })
  @ApiResponse({
    status: 200,
    description: 'Loan detail',
    schema: {
      example: {
        id: 'uuid',
        loanNumber: 'LN-2026-000001',
        status: 'ACTIVE',
        principalAmount: 50000,
        outstandingBalance: 42000,
        accruedInterest: 0,
        totalAmountDue: 42000,
        totalRepaid: 8000,
        disbursedAt: '2026-05-01T10:00:00.000Z',
        dueDate: '2027-05-01T00:00:00.000Z',
        recentTransactions: [],
        repaymentSchedule: [
          { month: 1, dueDate: '2026-06-01', expectedAmount: 4667, status: 'OVERDUE' },
        ],
      },
    },
  })
  @ApiResponse({ status: 403, description: 'Loan does not belong to authenticated member' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  async getLoanDetail(
    @Param('id', ParseUUIDPipe) loanId: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.portal.getLoanDetail(loanId, user.id, tenant.id);
  }

  // ─── GUARANTOR STATUS ──────────────────────────────────────────────────────

  @Get('loans/:id/guarantor-status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get guarantor status for a loan',
    description: 'Members can view the status of guarantors for their own loan applications.',
  })
  @ApiParam({ name: 'id', description: 'Loan UUID' })
  @ApiResponse({ status: 200, description: 'LoanGuarantor status list' })
  async getGuarantorStatus(
    @Param('id', ParseUUIDPipe) loanId: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
  ) {
    const memberId = await this.resolveMemberId(user.id, tenant.id);
    // Verify the loan belongs to this member
    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId: tenant.id, memberId },
      select: { id: true },
    });
    if (!loan) throw new ForbiddenException('Loan not found or does not belong to you');
    return this.loanApp.getGuarantorStatus(loanId, tenant.id);
  }

  // ─── M-PESA DEPOSIT ────────────────────────────────────────────────────────

  @Post('loans/:id/guarantors/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request guarantors for my loan',
    description:
      'Allows a member to nominate one or more guarantors for their own DRAFT or PENDING_GUARANTORS loan application. ' +
      'When only guarantorIds are supplied, remaining coverage is split equally.',
  })
  @ApiParam({ name: 'id', description: 'Loan UUID' })
  @ApiResponse({ status: 200, description: 'Guarantor requests created' })
  @ApiResponse({ status: 400, description: 'Loan status is not eligible or no guarantors were supplied' })
  @ApiResponse({ status: 403, description: 'Loan does not belong to authenticated member' })
  async requestGuarantors(
    @Param('id', ParseUUIDPipe) loanId: string,
    @Body() dto: MemberRequestGuarantorsDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    const memberId = await this.resolveMemberId(user.id, tenant.id);
    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId: tenant.id, memberId },
      select: {
        id: true,
        status: true,
        principalAmount: true,
        loanProduct: {
          select: {
            minGuarantors: true,
            guarantorCoverageRatio: true,
          },
        },
        guarantors: {
          select: {
            memberId: true,
            status: true,
            guaranteedAmount: true,
          },
        },
      },
    });
    if (!loan) throw new ForbiddenException('Loan not found or does not belong to you');
    if (loan.status !== LoanStatus.DRAFT && loan.status !== LoanStatus.PENDING_GUARANTORS) {
      throw new BadRequestException(`Cannot request guarantors for a loan in "${loan.status}" status`);
    }

    const requestedGuarantors = dto.guarantors?.length
      ? dto.guarantors
      : this.buildGuarantorNominationsFromIds(dto.guarantorIds ?? [], loan);

    if (requestedGuarantors.length === 0) {
      throw new BadRequestException('At least one guarantor is required');
    }

    const activeExisting = new Set(
      loan.guarantors
        .filter((guarantor) => guarantor.status === GuarantorStatus.PENDING || guarantor.status === GuarantorStatus.ACCEPTED)
        .map((guarantor) => guarantor.memberId),
    );
    const duplicate = requestedGuarantors.find((guarantor) => activeExisting.has(guarantor.memberId));
    if (duplicate) {
      throw new BadRequestException('This member has already been requested or has already accepted.');
    }

    return this.loanApp.inviteGuarantors(loanId, requestedGuarantors, tenant.id, user.id, req);
  }

  private buildGuarantorNominationsFromIds(
    guarantorIds: string[],
    loan: {
      principalAmount: unknown;
      loanProduct: { minGuarantors: number; guarantorCoverageRatio: unknown };
      guarantors: Array<{ memberId: string; status: GuarantorStatus; guaranteedAmount: unknown }>;
    },
  ) {
    const uniqueIds = Array.from(new Set(guarantorIds.filter(Boolean)));
    if (uniqueIds.length === 0) return [];

    const principal = new Decimal(String(loan.principalAmount));
    const coverageRatio = new Decimal(String(loan.loanProduct.guarantorCoverageRatio ?? '1'));
    const requiredCoverage = principal.times(coverageRatio);
    const activeCoverage = loan.guarantors
      .filter((guarantor) => guarantor.status === GuarantorStatus.PENDING || guarantor.status === GuarantorStatus.ACCEPTED)
      .reduce((sum, guarantor) => sum.plus(new Decimal(String(guarantor.guaranteedAmount))), new Decimal(0));
    const remainingCoverage = Decimal.max(requiredCoverage.minus(activeCoverage), 0);
    const fallbackShare = loan.loanProduct.minGuarantors > 0
      ? requiredCoverage.div(loan.loanProduct.minGuarantors)
      : principal.div(uniqueIds.length);
    const amountToSplit = remainingCoverage.greaterThan(0)
      ? remainingCoverage
      : fallbackShare.times(uniqueIds.length);
    const equalShare = amountToSplit.div(uniqueIds.length).toDecimalPlaces(4, Decimal.ROUND_DOWN);

    return uniqueIds.map((memberId, index) => ({
      memberId,
      guaranteedAmount: index === uniqueIds.length - 1
        ? amountToSplit.minus(equalShare.times(uniqueIds.length - 1)).toDecimalPlaces(4).toNumber()
        : equalShare.toNumber(),
    }));
  }

  @Post('deposit/mpesa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deposit via M-Pesa STK Push',
    description: 'Triggers an STK Push to the member\'s phone. Processed asynchronously via BullMQ.',
  })
  @ApiResponse({ status: 200, description: 'STK Push initiated' })
  async depositMpesa(
    @Body() dto: MemberDepositDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
  ) {
    const memberId = await this.resolveMemberId(user.id, tenant.id);
    return this.mpesa.initiateDeposit(dto, tenant.id, user.id, user.id);
  }
}
