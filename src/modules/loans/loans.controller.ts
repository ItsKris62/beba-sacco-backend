import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiSecurity,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiHeader,
} from '@nestjs/swagger';
import { LoanStatus, UserRole } from '@prisma/client';
import { Request } from 'express';
import { LoansService } from './loans.service';
import { CreateLoanProductDto } from './dto/create-loan-product.dto';
import { UpdateLoanProductDto } from './dto/update-loan-product.dto';
import { ApplyLoanDto } from './dto/apply-loan.dto';
import { ApproveLoanDto } from './dto/approve-loan.dto';
import { SignApprovalChainDto } from './dto/sign-approval-chain.dto';
import { InviteGuarantorsDto } from './dto/invite-guarantors.dto';
import { RejectLoanDto } from './dto/reject-loan.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

@ApiTags('Loans')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('loans')
export class LoansController {
  constructor(private readonly loans: LoansService) {}

  // ─── LOAN PRODUCTS ───────────────────────────────────────────

  @Post('products')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new loan product' })
  createProduct(
    @Body() dto: CreateLoanProductDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.loans.createProduct(dto, tenant.id, actor.id, req.ip);
  }

  @Get('products')
  @Roles(
    UserRole.TENANT_ADMIN,
    UserRole.MANAGER,
    UserRole.LOAN_OFFICER,
    UserRole.TELLER,
    UserRole.AUDITOR,
    UserRole.MEMBER,
  )
  @ApiOperation({ summary: 'List active loan products' })
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  findAllProducts(
    @CurrentTenant() tenant: Tenant,
    @Query('includeInactive') includeInactive?: boolean,
  ) {
    return this.loans.findAllProducts(
      tenant.id,
      includeInactive === true || String(includeInactive) === 'true',
    );
  }

  @Get('products/public')
  @Public()
  @ApiOperation({
    summary: 'List active loan products (public, unauthenticated)',
    description:
      'Read-only feed for the public marketing site and loan calculator. Always excludes inactive products regardless of query params.',
  })
  findPublicProducts(@CurrentTenant() tenant: Tenant) {
    return this.loans.findAllProducts(tenant.id, false);
  }

  @Get('products/:id')
  @Roles(
    UserRole.TENANT_ADMIN,
    UserRole.MANAGER,
    UserRole.LOAN_OFFICER,
    UserRole.TELLER,
    UserRole.AUDITOR,
  )
  @ApiOperation({ summary: 'Get loan product by ID' })
  findOneProduct(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() tenant: Tenant) {
    return this.loans.findOneProduct(id, tenant.id);
  }

  @Patch('products/:id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER)
  @ApiOperation({ summary: 'Update a loan product' })
  @ApiResponse({ status: 200, description: 'Loan product updated' })
  updateProduct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLoanProductDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.loans.updateProduct(id, dto, tenant.id, actor.id, req.ip);
  }

  @Delete('products/:id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate a loan product',
    description:
      'Soft-deactivates the product so existing loans retain their historical product reference.',
  })
  @ApiResponse({ status: 200, description: 'Loan product deactivated' })
  deactivateProduct(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.loans.deactivateProduct(id, tenant.id, actor.id, req.ip);
  }

  // ─── LOANS ───────────────────────────────────────────────────

  @Post('apply')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Apply for a loan on behalf of a member' })
  @ApiResponse({ status: 201, description: 'Loan application submitted (PENDING_APPROVAL)' })
  apply(
    @Body() dto: ApplyLoanDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.loans.apply(dto, tenant.id, actor.id, req.ip);
  }

  @Get()
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER, UserRole.AUDITOR)
  @ApiOperation({
    summary: 'List loans (optionally filtered by memberId or status)',
    description:
      'Each loan includes guarantorCoveragePercent (% of principal covered by ACCEPTED guarantors), ' +
      'computed via a single batched query for the whole page.',
  })
  @ApiQuery({ name: 'memberId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: LoanStatus })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Deprecated; use cursor' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAll(
    @CurrentTenant() tenant: Tenant,
    @Query('memberId') memberId?: string,
    @Query('status') status?: LoanStatus,
    @Query('cursor') cursor?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.loans.findAll(tenant.id, { memberId, status, cursor, page, limit });
  }

  @Get(':id')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'Get loan details (includes transactions and product)' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() tenant: Tenant) {
    return this.loans.findOne(id, tenant.id);
  }

  @Patch(':id/approve')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a loan application',
    description:
      'Approves a loan that is in PENDING_REVIEW or PENDING_APPROVAL status. ' +
      'An optional review comment is stored on the loan record and included in the audit trail.',
  })
  @ApiResponse({ status: 200, description: 'Loan approved' })
  @ApiResponse({ status: 400, description: 'Loan is not in an approvable status' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveLoanDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.loans.approve(id, tenant.id, actor.id, dto.comment, req.ip, req.get('user-agent'));
  }

  @Patch(':id/approval-chain/sign')
  @Roles(UserRole.MANAGER, UserRole.TELLER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Sign off on a large loan's 4-eyes disbursement approval chain",
    description:
      'For loans ≥ KES 500,000, disburse() is blocked until one MANAGER and one TELLER have each ' +
      'signed off here. The same person cannot fill both slots. Rejecting either slot permanently ' +
      'blocks disbursement for this loan.',
  })
  @ApiResponse({ status: 200, description: 'Sign-off recorded' })
  @ApiResponse({
    status: 400,
    description: 'No pending slot for this role, or approval chain does not exist',
  })
  @ApiResponse({ status: 403, description: 'This approver has already signed off on this loan' })
  signApprovalChain(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SignApprovalChainDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.loans.signApprovalChain(
      id,
      tenant.id,
      actor.id,
      actor.role,
      dto.approve,
      dto.notes,
      req.ip,
    );
  }

  @Patch(':id/disburse')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Disburse an approved loan',
    description:
      'Posts the approved loan to the member FOSA account using a Serializable transaction. ' +
      'The ledger records at least two entries: a gross LOAN_DISBURSEMENT credit for principal ' +
      'and a FEE_CHARGE debit for the processing fee. The member spendable balance increases by ' +
      'netDisbursement = principalAmount - processingFee, and the loan status changes to ACTIVE.',
  })
  @ApiResponse({
    status: 200,
    description: 'Loan disbursed and ledger entries posted',
    schema: {
      example: {
        loan: {
          id: '9b29f4b9-41a5-4ef6-8440-8e5d05f2ef51',
          loanNumber: 'LN-2026-000001',
          status: 'ACTIVE',
          principalAmount: '50000.0000',
          processingFee: '1000.0000',
          disbursedAt: '2026-06-18T09:00:00.000Z',
        },
        transaction: {
          type: 'LOAN_DISBURSEMENT',
          amount: '50000.0000',
          description: 'Loan disbursement - LN-2026-000001',
        },
        ledgerEntries: [
          { type: 'LOAN_DISBURSEMENT', amount: '50000.0000' },
          { type: 'FEE_CHARGE', amount: '-1000.0000' },
        ],
        principalAmount: 50000,
        processingFee: 1000,
        netDisbursement: 49000,
        newBalance: 59000,
        disbursement_status: 'COMPLETED',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Loan is not approved, KYC is not approved, or fee exceeds principal',
  })
  @ApiResponse({ status: 404, description: 'Loan or FOSA account not found' })
  @ApiResponse({
    status: 409,
    description: 'Loan already disbursed or concurrent account update detected',
  })
  disburse(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.loans.disburse(id, tenant.id, actor.id, req.ip);
  }

  @Patch(':id/reject')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a loan application with a mandatory reason' })
  @ApiResponse({ status: 200, description: 'Loan rejected' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectLoanDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.loans.reject(id, dto, tenant.id, actor.id, req.ip, req.get('user-agent'));
  }

  // ─── GUARANTORS ───────────────────────────────────────────────

  @Post(':id/invite-guarantors')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Invite guarantors for a DRAFT loan (moves status to PENDING_GUARANTORS)',
  })
  inviteGuarantors(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteGuarantorsDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.loans.inviteGuarantors(id, dto, tenant.id, actor.id, req.ip);
  }

  @Get(':id/guarantors')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'List guarantors and their response status for a loan' })
  getGuarantors(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() tenant: Tenant) {
    return this.loans.getGuarantors(id, tenant.id);
  }

  @Patch(':id/repay')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Post a loan repayment from member FOSA account',
    description:
      'Idempotent: pass idempotencyKey (or an X-Idempotency-Key header) to guarantee ' +
      'replay-safety on retry, or rely on the same-minute deterministic fallback key.',
  })
  @ApiHeader({ name: 'X-Idempotency-Key', required: false, description: 'Optional idempotency key' })
  repay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { amount: number; idempotencyKey?: string },
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const idempotencyKey =
      body.idempotencyKey ?? (req.headers['x-idempotency-key'] as string | undefined);
    return this.loans.repay(id, body.amount, tenant.id, actor.id, req.ip, idempotencyKey);
  }
}
