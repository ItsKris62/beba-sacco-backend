import {
  Controller, Get, Post, Patch, Body, Param, Query,
  HttpCode, HttpStatus, Req, UseGuards,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiResponse, ApiQuery, ApiHeader, ApiParam,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { MembersService } from './members.service';
import { LoansService } from '../loans/loans.service';
import { MpesaService } from '../mpesa/mpesa.service';
import { StatementService } from '../statements/statement.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';
import { MemberDepositDto } from '../mpesa/dto/deposit-request.dto';
import { ApplyLoanDto } from '../loans/dto/apply-loan.dto';
import { GuarantorResponseDto } from '../loans/dto/guarantor-response.dto';
import { PrismaService } from '../../prisma/prisma.service';

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
@Roles(UserRole.MEMBER)
@Controller('members')
export class MemberPortalController {
  constructor(
    private readonly members: MembersService,
    private readonly loans: LoansService,
    private readonly mpesa: MpesaService,
    private readonly statements: StatementService,
    private readonly prisma: PrismaService,
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
  @ApiResponse({ status: 200, description: 'Dashboard data' })
  async getDashboard(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
  ) {
    const memberId = await this.resolveMemberId(user.id, tenant.id);

    const [accounts, activeLoans, pendingDeposits] = await Promise.all([
      this.prisma.account.findMany({
        where: { memberId, tenantId: tenant.id, isActive: true },
        select: { accountType: true, balance: true, accountNumber: true },
      }),
      this.prisma.loan.findMany({
        where: { memberId, tenantId: tenant.id, status: { in: ['ACTIVE', 'DISBURSED', 'APPROVED'] } },
        select: { loanNumber: true, principalAmount: true, outstandingBalance: true, status: true },
        orderBy: { appliedAt: 'desc' },
        take: 5,
      }),
      this.prisma.mpesaTransaction.findMany({
        where: { memberId, tenantId: tenant.id, status: 'PENDING' },
        select: { amount: true, createdAt: true, type: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);

    return {
      memberId,
      accounts: accounts.map((a) => ({
        type: a.accountType,
        balance: a.balance,
        accountNumber: a.accountNumber,
      })),
      activeLoans: activeLoans.map((l) => ({
        loanNumber: l.loanNumber,
        principalAmount: l.principalAmount,
        outstandingBalance: l.outstandingBalance,
        status: l.status,
      })),
      pendingDeposits: pendingDeposits.map((d) => ({
        amount: d.amount,
        createdAt: d.createdAt,
        type: d.type,
      })),
    };
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
    description: 'Members can apply for Development or Jipange loan products.',
  })
  @ApiResponse({ status: 201, description: 'Loan application submitted' })
  async applyLoan(
    @Body() dto: ApplyLoanDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    const memberId = await this.resolveMemberId(user.id, tenant.id);
    // Override memberId to prevent members applying on behalf of others
    const safeDto = { ...dto, memberId };
    return this.loans.apply(safeDto, tenant.id, user.id, req.ip);
  }

  // ─── GUARANTOR RESPONSE ────────────────────────────────────────────────────

  @Post('loans/:id/guarantor-response')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Respond to a guarantor invitation',
    description: 'Accept or reject a loan guarantor request. OTP/email verification stub (MVP: placeholder).',
  })
  @ApiParam({ name: 'id', description: 'Loan UUID' })
  @ApiResponse({ status: 200, description: 'Response recorded' })
  async guarantorResponse(
    @Param('id') loanId: string,
    @Body() dto: GuarantorResponseDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    const memberId = await this.resolveMemberId(user.id, tenant.id);
    // MVP: OTP/email verification stub — always pass for now
    // Phase 2+: integrate SMS/Email OTP verification here
    return this.loans.respondAsGuarantor(loanId, memberId, dto, tenant.id, req.ip);
  }

  // ─── M-PESA DEPOSIT ────────────────────────────────────────────────────────

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
