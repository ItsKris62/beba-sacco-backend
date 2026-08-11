import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  BadRequestException,
  HttpCode,
  HttpStatus,
  Req,
  ForbiddenException,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiSecurity,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiHeader,
  ApiParam,
} from '@nestjs/swagger';
import { GuarantorStatus, LoanStatus, UserRole } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { MembersService } from './members.service';
import { MemberPortalService } from './member-portal.service';
import { LoansService } from '../loans/loans.service';
import { LoanApplicationService } from '../loans/loan-application.service';
import { StatementService } from '../statements/statement.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';
import { MemberApplyLoanDto, MemberRequestGuarantorsDto } from '../loans/dto/member-apply-loan.dto';
import { MemberStkPushDto } from './dto/member-stk-push.dto';
import { WithdrawMpesaDto } from './dto/withdraw-mpesa.dto';
import { InternalTransferDto } from './dto/internal-transfer.dto';
import { PatchProfileDto } from './dto/patch-profile.dto';
import {
  ProfileImageUploadUrlRequestDto,
  ProfileImageUploadUrlResponseDto,
  ProfileImageUrlResponseDto,
} from './dto/profile-image.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { MemberDashboardDto } from '../../common/dto/member-dashboard.dto';
import { DocumentsService } from '../documents/documents.service';
import {
  ConfirmDocumentUploadDto,
  DocumentUploadUrlResponseDto,
  RequestDocumentUploadUrlDto,
} from '../documents/dto/document.dto';
import { ApiErrorExamples } from '../../common/swagger/error-response-examples';

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
@ApiHeader({
  name: 'X-Correlation-ID',
  required: false,
  description: 'Optional request tracing ID',
})
@Roles(UserRole.MEMBER, UserRole.LOAN_OFFICER)
@Controller('members')
export class MemberPortalController {
  constructor(
    private readonly members: MembersService,
    private readonly portal: MemberPortalService,
    private readonly loans: LoansService,
    private readonly loanApp: LoanApplicationService,
    private readonly statements: StatementService,
    private readonly prisma: PrismaService,
    private readonly dashboardService: DashboardService,
    private readonly documents: DocumentsService,
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

  // ─── PROFILE ───────────────────────────────────────────────────────────────

  @Patch('profile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update my profile',
    description:
      'Members can update their own phone, email, employer, and occupation. ' +
      'Stage assignments are reserved for admin use and are ignored here.',
  })
  @ApiResponse({ status: 200, description: 'Profile updated' })
  async patchMyProfile(
    @Body() dto: PatchProfileDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    const memberId = await this.resolveMemberId(user.id, tenant.id);
    // Members cannot manage their own stage assignments
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { stageIds: _ignored, ...profileFields } = dto;
    return this.members.patchProfile(memberId, profileFields, tenant.id, user.id, req.ip);
  }

  // ─── DASHBOARD ─────────────────────────────────────────────────────────────

  @Post('profile/image-url')
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Request a profile image upload URL',
    description:
      'Returns a short-lived pre-signed R2 PUT URL and the tenant/user-scoped avatar object key.',
  })
  @ApiResponse({
    status: 201,
    description: 'Pre-signed profile image upload URL',
    type: ProfileImageUploadUrlResponseDto,
  })
  requestProfileImageUploadUrl(
    @Body() dto: ProfileImageUploadUrlRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.portal.requestProfileImageUploadUrl(tenant.id, user.id, dto);
  }

  @Get('profile/image-url')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get my profile image display URL' })
  @ApiResponse({
    status: 200,
    description: 'Pre-signed profile image display URL, or null when no image is saved',
    type: ProfileImageUrlResponseDto,
  })
  getProfileImageUrl(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: Tenant) {
    return this.portal.getProfileImageUrl(tenant.id, user.id);
  }

  @Get('dashboard')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Member personal dashboard',
    description:
      'Returns balances, active loans, and pending deposits for the authenticated member.',
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

  @Post('documents/upload-url')
  @Throttle({ global: { limit: 12, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Request a pre-signed KYC document upload URL',
    description:
      'Creates a tenant-scoped Document upload intent and returns a short-lived R2/MinIO PUT URL.',
  })
  @ApiResponse({
    status: 201,
    description: 'Pre-signed upload URL. uploadToken is present only in secure mode.',
    type: DocumentUploadUrlResponseDto,
  })
  @ApiResponse({ status: 400, ...ApiErrorExamples.badUploadRequest })
  @ApiResponse({ status: 401, ...ApiErrorExamples.authenticationRequired })
  @ApiResponse({ status: 403, ...ApiErrorExamples.forbiddenTenant })
  @ApiResponse({ status: 413, ...ApiErrorExamples.payloadTooLarge })
  @ApiResponse({ status: 429, ...ApiErrorExamples.rateLimited })
  @ApiResponse({ status: 500, ...ApiErrorExamples.internalServerError })
  requestDocumentUploadUrl(
    @Body() dto: RequestDocumentUploadUrlDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    return this.documents.requestMemberUploadUrl(tenant.id, user.id, dto, req.ip);
  }

  @Post('documents/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm a direct-to-storage KYC document upload',
    description:
      'HEAD-checks the uploaded object, validates tenant/member key ownership, and moves the document to PENDING_REVIEW.',
  })
  @ApiResponse({ status: 200, description: 'Upload confirmed' })
  @ApiResponse({ status: 400, ...ApiErrorExamples.checksumFailed })
  @ApiResponse({ status: 401, ...ApiErrorExamples.authenticationRequired })
  @ApiResponse({ status: 403, ...ApiErrorExamples.forbiddenTenant })
  @ApiResponse({ status: 404, ...ApiErrorExamples.notFound })
  @ApiResponse({ status: 409, ...ApiErrorExamples.uploadTokenConflict })
  @ApiResponse({ status: 500, ...ApiErrorExamples.internalServerError })
  confirmDocumentUpload(
    @Body() dto: ConfirmDocumentUploadDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    return this.documents.confirmMemberUpload(tenant.id, user.id, dto, req.ip);
  }

  @Post('documents/:id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm a direct-to-storage KYC document upload by document ID',
    description: 'Compatibility route for clients that pass the document ID in the path.',
  })
  @ApiResponse({ status: 200, description: 'Upload confirmed' })
  @ApiResponse({ status: 400, ...ApiErrorExamples.checksumFailed })
  @ApiResponse({ status: 401, ...ApiErrorExamples.authenticationRequired })
  @ApiResponse({ status: 403, ...ApiErrorExamples.forbiddenTenant })
  @ApiResponse({ status: 404, ...ApiErrorExamples.notFound })
  @ApiResponse({ status: 409, ...ApiErrorExamples.uploadTokenConflict })
  @ApiResponse({ status: 500, ...ApiErrorExamples.internalServerError })
  confirmDocumentUploadById(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: Partial<ConfirmDocumentUploadDto> | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    return this.documents.confirmMemberUpload(
      tenant.id,
      user.id,
      { documentId: id, checksum: dto?.checksum, uploadToken: dto?.uploadToken },
      req.ip,
    );
  }

  @Get('documents')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List my KYC documents' })
  @ApiResponse({ status: 200, description: 'Authenticated member documents' })
  listMyDocuments(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: Tenant) {
    return this.documents.listMemberDocuments(tenant.id, user.id);
  }

  @Get('documents/:id/download')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate a short-lived download URL for my document' })
  @ApiResponse({ status: 200, description: 'Pre-signed download URL' })
  getMyDocumentDownloadUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    return this.documents.getMemberDownloadUrl(tenant.id, user.id, id, req.ip);
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
    return this.statements.getFosaStatement(tenant.id, user.id, memberId, periodFrom, periodTo, {
      page,
      limit,
    });
  }

  // ─── LOAN SELF-APPLICATION ─────────────────────────────────────────────────

  @Post('loans/apply')
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
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
  @ApiResponse({
    status: 422,
    description: 'Eligibility not met: KYC pending, deposit limit, or defaulted loan',
  })
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

  // ─── LOAN LIST ────────────────────────────────────────────────────────────

  @Get('loans')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List my loan applications (member self-service)',
    description:
      'Returns all loan applications belonging to the authenticated member, across every status ' +
      '(DRAFT through FULLY_PAID/DEFAULTED), so the member portal can render current/pending/past loans.',
  })
  @ApiQuery({ name: 'status', required: false, enum: LoanStatus })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Deprecated; use cursor' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Loan applications for the authenticated member' })
  async listMyLoans(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Query('status') status?: LoanStatus,
    @Query('cursor') cursor?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const memberId = await this.resolveMemberId(user.id, tenant.id);
    return this.loans.findAll(tenant.id, { memberId, status, cursor, page, limit });
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
  @ApiResponse({
    status: 400,
    description: 'Loan status is not eligible or no guarantors were supplied',
  })
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
            maxGuarantors: true,
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
      throw new BadRequestException(
        `Cannot request guarantors for a loan in "${loan.status}" status`,
      );
    }

    const requestedGuarantors = dto.guarantors?.length
      ? dto.guarantors
      : this.buildGuarantorNominationsFromIds(dto.guarantorIds ?? [], loan);

    if (requestedGuarantors.length === 0) {
      throw new BadRequestException('At least one guarantor is required');
    }

    const activeCount = loan.guarantors.filter(
      (guarantor) =>
        guarantor.status === GuarantorStatus.PENDING ||
        guarantor.status === GuarantorStatus.ACCEPTED,
    ).length;
    if (
      loan.loanProduct.maxGuarantors > 0 &&
      activeCount + requestedGuarantors.length > loan.loanProduct.maxGuarantors
    ) {
      throw new BadRequestException(
        `This product allows at most ${loan.loanProduct.maxGuarantors} guarantor(s).`,
      );
    }

    const activeExisting = new Set(
      loan.guarantors
        .filter(
          (guarantor) =>
            guarantor.status === GuarantorStatus.PENDING ||
            guarantor.status === GuarantorStatus.ACCEPTED,
        )
        .map((guarantor) => guarantor.memberId),
    );
    const duplicate = requestedGuarantors.find((guarantor) =>
      activeExisting.has(guarantor.memberId),
    );
    if (duplicate) {
      throw new BadRequestException(
        'This member has already been requested or has already accepted.',
      );
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
      .filter(
        (guarantor) =>
          guarantor.status === GuarantorStatus.PENDING ||
          guarantor.status === GuarantorStatus.ACCEPTED,
      )
      .reduce(
        (sum, guarantor) => sum.plus(new Decimal(String(guarantor.guaranteedAmount))),
        new Decimal(0),
      );
    const remainingCoverage = Decimal.max(requiredCoverage.minus(activeCoverage), 0);
    const fallbackShare =
      loan.loanProduct.minGuarantors > 0
        ? requiredCoverage.div(loan.loanProduct.minGuarantors)
        : principal.div(uniqueIds.length);
    const amountToSplit = remainingCoverage.greaterThan(0)
      ? remainingCoverage
      : fallbackShare.times(uniqueIds.length);
    const equalShare = amountToSplit.div(uniqueIds.length).toDecimalPlaces(4, Decimal.ROUND_DOWN);

    return uniqueIds.map((memberId, index) => ({
      memberId,
      guaranteedAmount:
        index === uniqueIds.length - 1
          ? amountToSplit
              .minus(equalShare.times(uniqueIds.length - 1))
              .toDecimalPlaces(4)
              .toNumber()
          : equalShare.toNumber(),
    }));
  }

  @Post('deposit/mpesa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deposit via M-Pesa STK Push',
    description: "Triggers an STK Push to the member's phone. Processed asynchronously via BullMQ.",
  })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: true,
    description: 'Required to prevent duplicate STK prompts on retry',
  })
  @ApiResponse({ status: 200, description: 'STK Push initiated' })
  @ApiResponse({
    status: 400,
    description: 'Invalid amount, phone, missing FOSA account, or missing idempotency key',
  })
  @ApiResponse({ status: 503, description: 'M-Pesa temporarily unavailable' })
  async depositMpesa(
    @Body() dto: MemberStkPushDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    const idempotencyKey =
      (req.headers['x-idempotency-key'] as string | undefined) ??
      (req.headers['idempotency-key'] as string | undefined);
    return this.portal.initiateDeposit(
      user.id,
      dto.phone,
      dto.amount,
      tenant.id,
      req.ip,
      idempotencyKey,
    );
  }

  @Post('withdraw/mpesa')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw from FOSA to M-Pesa',
    description: "Withdraws available FOSA funds to the member's phone via M-Pesa B2C.",
  })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: true,
    description: 'Required to prevent duplicate withdrawal debits on client retry.',
  })
  @ApiResponse({ status: 200, description: 'Withdrawal initiated successfully' })
  @ApiResponse({
    status: 400,
    description: 'Insufficient FOSA available balance, or missing idempotency key',
  })
  async withdrawMpesa(
    @Body() dto: WithdrawMpesaDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    const idempotencyKey =
      (req.headers['x-idempotency-key'] as string | undefined) ??
      (req.headers['idempotency-key'] as string | undefined);
    return this.portal.withdrawMpesa(
      user.id,
      dto.phoneNumber,
      dto.amount,
      tenant.id,
      req.ip,
      idempotencyKey,
    );
  }

  @Get('withdraw/mpesa/:transactionId/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check M-Pesa withdrawal status',
    description:
      'Returns the provider payout status for a FOSA withdrawal owned by the authenticated member.',
  })
  @ApiParam({
    name: 'transactionId',
    description: 'Ledger Transaction UUID returned by withdraw/mpesa',
  })
  @ApiResponse({ status: 200, description: 'Withdrawal status' })
  @ApiResponse({ status: 404, description: 'Withdrawal transaction not found' })
  async getWithdrawalStatus(
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.portal.getWithdrawalStatus(user.id, transactionId, tenant.id);
  }

  @Post('accounts/transfer')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Transfer funds between own FOSA and BOSA accounts',
    description:
      "Moves money between the authenticated member's own FOSA and BOSA accounts. " +
      'Minimum transfer amount is KES 100. The source account must have sufficient ' +
      'available balance (respecting the minimum balance floor).',
  })
  @ApiResponse({ status: 200, description: 'Transfer completed successfully' })
  @ApiResponse({
    status: 400,
    description: 'Insufficient funds, below minimum balance, or invalid transfer parameters',
  })
  @ApiResponse({ status: 404, description: 'Source or destination account not found' })
  @ApiResponse({ status: 429, description: 'Too many transfer requests — max 5 per minute' })
  async internalTransfer(
    @Body() dto: InternalTransferDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    return this.portal.internalTransfer(user.id, tenant.id, dto, req.ip);
  }
}
