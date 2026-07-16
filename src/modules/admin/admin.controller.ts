import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
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
import { TransactionStatus, TransactionType, UserRole, AccountStatus } from '@prisma/client';
import { Request } from 'express';
import { AdminService } from './admin.service';
import { UpdateKycDto } from './dto/update-kyc.dto';
import { GetTransactionsQueryDto } from './dto/get-transactions.dto';
import {
  GetTransactionStatsQueryDto,
  TransactionStatsResponseDto,
} from './dto/get-transaction-stats.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';
import { ApiErrorExamples } from '../../common/swagger/error-response-examples';

@ApiTags('Admin')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@ApiHeader({
  name: 'X-Correlation-ID',
  required: false,
  description: 'Optional request tracing ID',
})
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ─── DASHBOARD ────────────────────────────────────────────────

  @Get('dashboard/stats')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({
    summary: 'Admin dashboard stats',
    description:
      'Returns total members, active loans, pending KYC count, pending approvals, M-Pesa volume, ' +
      'default rate, Portfolio at Risk > 30 days (loans.portfolioAtRisk30d, derived from LoanStaging), ' +
      'and loan disbursement totals for this month and overall (loans.disbursements).',
  })
  @ApiResponse({ status: 200, description: 'Aggregated metrics' })
  getDashboardStats(@CurrentTenant() tenant: Tenant) {
    return this.adminService.getDashboardStats(tenant.id);
  }

  // ─── MEMBERS ─────────────────────────────────────────────────

  @Get('members')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'Paginated, searchable member list with role and status filters' })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by name, email, member number, or national ID',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'accountStatus', required: false, enum: AccountStatus })
  @ApiQuery({ name: 'recentlyActive', required: false, type: Boolean })
  @ApiQuery({ name: 'role', required: false, enum: UserRole })
  getMembers(
    @CurrentTenant() tenant: Tenant,
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('accountStatus') accountStatus?: AccountStatus,
    @Query('recentlyActive') recentlyActive?: boolean,
    @Query('role') role?: UserRole,
  ) {
    return this.adminService.getMembers(tenant.id, {
      search,
      page,
      limit,
      accountStatus,
      recentlyActive,
      role,
    });
  }

  // ─── PENDING KYC QUEUE ───────────────────────────────────────

  @Get('members/pending')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER)
  @ApiOperation({
    summary: 'List members pending KYC review or with incomplete submissions',
    description:
      'PENDING_REVIEW returns members awaiting staff review (all required docs uploaded), ' +
      'INCOMPLETE returns members still missing required documents, ALL returns both, in FIFO order.',
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({
    name: 'statusFilter',
    required: false,
    enum: ['ALL', 'PENDING_REVIEW', 'INCOMPLETE'],
  })
  @ApiResponse({ status: 200, description: 'Paginated pending/incomplete members' })
  getPendingMembers(
    @CurrentTenant() tenant: Tenant,
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('statusFilter') statusFilter?: 'ALL' | 'PENDING_REVIEW' | 'INCOMPLETE',
  ) {
    return this.adminService.getPendingMembers(tenant.id, { search, page, limit, statusFilter });
  }

  // ─── TRANSACTIONS ─────────────────────────────────────────────

  @Get('transactions/stats')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Aggregated transaction flow stats',
    description:
      'Returns completed transaction inflows, outflows, volume, and net flow. ' +
      "TENANT_ADMIN / MANAGER / AUDITOR see only their tenant's transactions. " +
      'SUPER_ADMIN omits tenant scoping to query across all tenants.',
  })
  @ApiQuery({ name: 'from', required: false, description: 'ISO 8601 start date' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO 8601 end date' })
  @ApiQuery({ name: 'search', required: false, description: 'Reference or account number' })
  @ApiResponse({ status: 200, type: TransactionStatsResponseDto })
  getTransactionStats(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetTransactionStatsQueryDto,
  ) {
    const tenantId = user.role === UserRole.SUPER_ADMIN ? undefined : tenant.id;
    return this.adminService.getTransactionStats(tenantId, query);
  }

  @Get('transactions')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Paginated, filterable transaction list',
    description:
      "TENANT_ADMIN / MANAGER / AUDITOR see only their tenant's transactions. " +
      'SUPER_ADMIN omits tenant scoping to query across all tenants.',
  })
  @ApiQuery({ name: 'type', required: false, enum: TransactionType })
  @ApiQuery({ name: 'status', required: false, enum: TransactionStatus })
  @ApiQuery({ name: 'from', required: false, description: 'ISO 8601 start date' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO 8601 end date' })
  @ApiQuery({ name: 'search', required: false, description: 'Reference or account number' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated transactions with member/account context' })
  getTransactions(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetTransactionsQueryDto,
  ) {
    const tenantId = user.role === UserRole.SUPER_ADMIN ? undefined : tenant.id;
    return this.adminService.getTransactions(tenantId, query);
  }

  // ─── KYC UPDATE ──────────────────────────────────────────────

  @Patch('members/:id/kyc')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update member KYC information',
    description:
      'Authoritative existing-member KYC endpoint. Updates identity fields and, when verified is supplied, ' +
      'approves or rejects KYC using approved documentIds, notes, and a boolean checklist. Approval creates missing FOSA/BOSA accounts.',
  })
  @ApiResponse({ status: 200, description: 'KYC updated' })
  @ApiResponse({ status: 400, ...ApiErrorExamples.badUploadRequest })
  @ApiResponse({ status: 401, ...ApiErrorExamples.authenticationRequired })
  @ApiResponse({ status: 403, ...ApiErrorExamples.forbiddenTenant })
  @ApiResponse({ status: 404, ...ApiErrorExamples.notFound })
  @ApiResponse({ status: 500, ...ApiErrorExamples.internalServerError })
  updateKyc(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateKycDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.adminService.updateKyc(id, dto, tenant.id, actor.id, req.ip, req.get('user-agent'));
  }
}
