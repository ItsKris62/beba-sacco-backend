import {
  Controller, Get, Post, Patch, Param, Body, Delete,
  Query, HttpCode, HttpStatus, ParseUUIDPipe, ParseFloatPipe, Req,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiResponse, ApiQuery, ApiHeader,
} from '@nestjs/swagger';
import { LoanStatus, UserRole } from '@prisma/client';
import { Request } from 'express';
import { LoansService } from './loans.service';
import { CreateLoanProductDto } from './dto/create-loan-product.dto';
import { ApplyLoanDto } from './dto/apply-loan.dto';
import { ApproveLoanDto } from './dto/approve-loan.dto';
import { InviteGuarantorsDto } from './dto/invite-guarantors.dto';
import { GuarantorResponseDto } from './dto/guarantor-response.dto';
import { RejectLoanDto } from './dto/reject-loan.dto';
import { Roles } from '../../common/decorators/roles.decorator';
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
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
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
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER, UserRole.AUDITOR, UserRole.MEMBER)
  @ApiOperation({ summary: 'List active loan products' })
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  findAllProducts(
    @CurrentTenant() tenant: Tenant,
    @Query('includeInactive') includeInactive?: boolean,
  ) {
    return this.loans.findAllProducts(tenant.id, includeInactive === true);
  }

  @Get('products/:id')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'Get loan product by ID' })
  findOneProduct(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.loans.findOneProduct(id, tenant.id);
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
  @ApiOperation({ summary: 'List loans (optionally filtered by memberId or status)' })
  @ApiQuery({ name: 'memberId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: LoanStatus })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAll(
    @CurrentTenant() tenant: Tenant,
    @Query('memberId') memberId?: string,
    @Query('status') status?: LoanStatus,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.loans.findAll(tenant.id, { memberId, status, page, limit });
  }

  @Get(':id')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'Get loan details (includes transactions and product)' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.loans.findOne(id, tenant.id);
  }

  @Patch(':id/approve')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a loan application',
    description:
      'Approves a loan that is in UNDER_REVIEW or PENDING_APPROVAL status. ' +
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
    return this.loans.approve(id, tenant.id, actor.id, dto.comment, req.ip);
  }

  @Patch(':id/disburse')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Disburse an approved loan',
    description:
      'Credits the member\'s FOSA account with the principal amount. ' +
      'The loan status changes to ACTIVE.',
  })
  @ApiResponse({ status: 200, description: 'Loan disbursed' })
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
    return this.loans.reject(id, dto, tenant.id, actor.id, req.ip);
  }

  // ─── GUARANTORS ───────────────────────────────────────────────

  @Post(':id/invite-guarantors')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Invite guarantors for a DRAFT loan (moves status to PENDING_GUARANTORS)' })
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
  getGuarantors(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.loans.getGuarantors(id, tenant.id);
  }

  @Patch(':id/repay')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Post a loan repayment from member FOSA account' })
  repay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { amount: number },
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.loans.repay(id, body.amount, tenant.id, actor.id, req.ip);
  }
}
