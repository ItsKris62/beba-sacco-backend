import { Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AccountingService } from './accounting.service';
import {
  GetPendingReconQueryDto,
  LedgerQueryDto,
  ReconQueryDto,
  ReportsQueryDto,
} from './dto/accounting-query.dto';
import { MatchMpesaTransactionDto } from './dto/match-mpesa.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

@ApiTags('Admin - Accounting')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Roles(UserRole.MANAGER, UserRole.TENANT_ADMIN)
@Controller('admin/accounting')
export class AccountingController {
  constructor(private readonly accounting: AccountingService) {}

  @Get('ledgers')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Transaction ledger grouped by account and day',
    description:
      'Returns COMPLETED transactions grouped by account and calendar day with ' +
      'opening/closing balances and totalIn/totalOut aggregates. ' +
      'Provide accountId to drill down into a single account and include individual transaction rows.',
  })
  @ApiQuery({ name: 'startDate', required: false, example: '2026-01-01' })
  @ApiQuery({ name: 'endDate', required: false, example: '2026-05-31' })
  @ApiQuery({ name: 'accountId', required: false, type: String })
  @ApiResponse({
    status: 200,
    description: 'Ledger grouped by account and day',
    schema: {
      example: {
        data: [
          {
            date: '2026-05-08',
            accountId: 'uuid',
            accountNumber: 'ACC-FOSA-000001',
            accountType: 'FOSA',
            openingBalance: 10000,
            closingBalance: 15000,
            totalIn: 5000,
            totalOut: 0,
            transactionCount: 1,
          },
        ],
        meta: { count: 1, startDate: '2026-01-01', endDate: '2026-05-31', accountId: null },
      },
    },
  })
  async getLedgers(@Query() query: LedgerQueryDto, @CurrentTenant() tenant: Tenant) {
    return this.accounting.getLedger(tenant.id, query);
  }

  @Get('reconciliation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'M-Pesa reconciliation report',
    description:
      'Returns the cached daily reconciliation report written by the nightly BullMQ job, ' +
      'plus a live count and list of RECON_PENDING M-Pesa transactions.',
  })
  @ApiQuery({
    name: 'date',
    required: false,
    example: '2026-05-08',
    description: 'Settlement date (defaults to today)',
  })
  @ApiResponse({
    status: 200,
    description: 'Reconciliation report and live RECON_PENDING transactions',
    schema: {
      example: {
        settlementDate: '2026-05-08',
        cachedReport: {
          totalDaraja: 250000,
          totalPosted: 250000,
          mismatches: [],
          duplicates: [],
          autoResolved: 0,
        },
        reconPending: { count: 2, transactions: [] },
      },
    },
  })
  async getReconciliation(@Query() query: ReconQueryDto, @CurrentTenant() tenant: Tenant) {
    return this.accounting.getReconciliation(tenant.id, query);
  }

  @Get('reconciliation/pending')
  @Roles(UserRole.MANAGER, UserRole.AUDITOR, UserRole.LOAN_OFFICER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List reconciliation mismatches pending admin review',
    description:
      'Returns paginated RECON_PENDING M-Pesa reconciliation items for the current tenant. ' +
      'Use this endpoint for manager, auditor, and loan officer review queues.',
  })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'startDate', required: false, example: '2026-05-01' })
  @ApiQuery({ name: 'endDate', required: false, example: '2026-05-08' })
  @ApiQuery({ name: 'type', required: false, enum: ['STK', 'B2C'] })
  @ApiResponse({
    status: 200,
    description: 'Paginated RECON_PENDING reconciliation mismatches',
    schema: {
      example: {
        data: [
          {
            id: 'mpesa-txn-uuid',
            reference: 'STK-ws_CO_123456',
            type: 'STK',
            amount: 1000,
            expectedAmount: null,
            mpesaReceipt: null,
            createdAt: '2026-05-08T06:30:00.000Z',
            flagReason: 'Stale PENDING after 180 minutes',
            reconciliationStatus: 'RECON_PENDING',
          },
        ],
        meta: { page: 1, limit: 20, total: 1, totalPages: 1, type: 'STK' },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden: user role is not permitted to review pending reconciliation',
  })
  async getPendingReconciliation(
    @Query() query: GetPendingReconQueryDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const allowed = new Set<UserRole>([
      UserRole.MANAGER,
      UserRole.AUDITOR,
      UserRole.LOAN_OFFICER,
      UserRole.TENANT_ADMIN,
      UserRole.SUPER_ADMIN,
    ]);

    if (!allowed.has(user.role)) {
      throw new ForbiddenException(
        'Only managers, auditors, and loan officers can review pending reconciliation',
      );
    }

    return this.accounting.getPendingReconciliation(tenant.id, query);
  }

  @Post('reconciliation/:id/match')
  @Roles(UserRole.MANAGER, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Match an unlinked MPESA transaction to a member account',
    description:
      'Manually reconciles a RECON_PENDING M-Pesa transaction by linking it to the specified ' +
      'account and posting a DEPOSIT ledger entry. The operation is atomic (SERIALIZABLE) and ' +
      'idempotent — re-submitting the same mpesaTxId returns the existing result without ' +
      'double-posting. Only MANAGER and TENANT_ADMIN may perform this action. An audit log ' +
      'entry is written for every successful match.',
  })
  @ApiParam({ name: 'id', description: 'RECON_PENDING MpesaTransaction UUID' })
  @ApiBody({ type: MatchMpesaTransactionDto })
  @ApiResponse({
    status: 200,
    description: 'Transaction matched and account credited',
    schema: {
      example: {
        success: true,
        transactionId: 'tx-uuid',
        amount: 5000,
        balanceBefore: 12000,
        balanceAfter: 17000,
        accountNumber: 'ACC-FOSA-000042',
        memberName: 'Jane Doe',
      },
    },
  })
  @ApiResponse({ status: 404, description: 'RECON_PENDING transaction or target account not found' })
  @ApiResponse({ status: 409, description: 'Transaction already matched (should not normally occur)' })
  async matchMpesaTransaction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MatchMpesaTransactionDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.accounting.matchMpesaTransaction(id, tenant.id, dto.accountId, user.id, dto.note);
  }

  @Get('reports')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Financial summary report',
    description:
      'Aggregates account book (FOSA/BOSA balances), loan book (counts and principal sums by status), ' +
      'and M-Pesa STK inflow volume for the requested period. Account book reflects current balances.',
  })
  @ApiQuery({ name: 'startDate', required: false, example: '2026-01-01' })
  @ApiQuery({ name: 'endDate', required: false, example: '2026-05-31' })
  @ApiResponse({
    status: 200,
    description: 'Financial summary report',
    schema: {
      example: {
        period: { startDate: '2026-01-01', endDate: '2026-05-31' },
        accountBook: [
          { accountType: 'FOSA', totalBalance: 5000000, accountCount: 120 },
          { accountType: 'BOSA', totalBalance: 8000000, accountCount: 118 },
        ],
        loanBook: [
          { status: 'ACTIVE', count: 45, totalPrincipal: 9000000, totalOutstanding: 7200000 },
          { status: 'FULLY_PAID', count: 12, totalPrincipal: 2400000, totalOutstanding: 0 },
        ],
        mpesaVolume: { totalAmount: 3500000, transactionCount: 210 },
        generatedAt: '2026-05-08T10:00:00.000Z',
      },
    },
  })
  async getReports(@Query() query: ReportsQueryDto, @CurrentTenant() tenant: Tenant) {
    return this.accounting.getReport(tenant.id, query);
  }
}
