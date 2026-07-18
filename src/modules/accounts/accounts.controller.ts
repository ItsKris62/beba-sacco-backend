import {
  Controller, Get, Post, Body, Param, Query,
  HttpCode, HttpStatus, ParseUUIDPipe, ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiResponse, ApiQuery, ApiHeader, ApiParam,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { TransferFundsDto } from './dto/transfer-funds.dto';
import { CashMovementDto } from './dto/cash-movement.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

/**
 * Deterministic idempotency reference for teller cash movements. Never generate
 * a fresh uuid() per request here — that would defeat LedgerService.postEntry()'s
 * replay protection on every network retry, double-posting the same cash movement.
 * When the caller supplies their own idempotencyKey, that scopes replay detection
 * to the specific request; otherwise fall back to a same-minute deterministic key
 * so an automatic client retry (not an intentional second deposit) still collapses
 * to one posting.
 */
function buildCashMovementReference(
  type: 'DEP' | 'WDR',
  tenantId: string,
  accountId: string,
  amount: number,
  idempotencyKey?: string,
): string {
  if (idempotencyKey) {
    return `${type}-${tenantId}-${idempotencyKey}`;
  }
  const minuteBucket = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return `TXN-${type}-${tenantId}-${accountId}-${amount}-${minuteBucket}`;
}

@ApiTags('Accounts')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@ApiParam({ name: 'id', description: 'Account UUID' })
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Post()
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Open a new BOSA or FOSA account for a member' })
  @ApiResponse({ status: 201, description: 'Account opened' })
  @ApiResponse({ status: 404, description: 'Member not found in this tenant' })
  @ApiResponse({ status: 409, description: 'Member already has an active account of this type' })
  create(
    @Body() dto: CreateAccountDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.accounts.create(dto, tenant.id, actor.id);
  }

  @Get()
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'List accounts (optionally filtered by memberId)' })
  @ApiQuery({ name: 'memberId', required: false })
  @ApiResponse({ status: 200, description: 'List of accounts' })
  findAll(
    @CurrentTenant() tenant: Tenant,
    @Query('memberId') memberId?: string,
  ) {
    return this.accounts.findAll(tenant.id, memberId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get account with member info' })
  @ApiResponse({ status: 200, description: 'Account with member info' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.accounts.findOne(id, tenant.id);
  }

  @Get(':id/transactions')
  @ApiOperation({ summary: 'Paginated transaction history for an account' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated transaction list' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  getTransactions(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.accounts.getTransactions(id, tenant.id, page, limit);
  }

  @Post(':id/deposit')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Post a manual cash deposit',
    description: 'Credits the account via LedgerService.postEntry() (debit CASH, credit the account\'s deposit-liability GL code). Idempotent: pass idempotencyKey to guarantee replay-safety, or rely on the same-minute deterministic fallback key.',
  })
  @ApiResponse({ status: 200, description: 'Deposit posted' })
  @ApiResponse({ status: 404, description: 'Account not found or inactive' })
  @ApiResponse({ status: 400, description: 'Amount must be positive' })
  deposit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CashMovementDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const reference = buildCashMovementReference('DEP', tenant.id, id, body.amount, body.idempotencyKey);
    return this.accounts.deposit(
      id,
      body.amount,
      reference,
      body.description ?? 'Cash deposit',
      tenant.id,
      actor.id,
    );
  }

  @Post(':id/withdraw')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Post a cash withdrawal',
    description: 'Debits the account via LedgerService.postEntry() (debit the account\'s deposit-liability GL code, credit CASH). Enforces the account\'s minimum-balance floor unless allowsNegative is set, and never permits a debit into funds committed to a guarantor hold (lockedBalance/frozenSavings) regardless of allowsNegative.',
  })
  @ApiResponse({ status: 200, description: 'Withdrawal posted' })
  @ApiResponse({ status: 404, description: 'Account not found or inactive' })
  @ApiResponse({ status: 400, description: 'Amount must be positive, or below minimum balance requirement' })
  withdraw(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CashMovementDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const reference = buildCashMovementReference('WDR', tenant.id, id, body.amount, body.idempotencyKey);
    return this.accounts.withdraw(
      id,
      body.amount,
      reference,
      body.description ?? 'Cash withdrawal',
      tenant.id,
      actor.id,
    );
  }

  @Post(':id/transfer')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Transfer funds between two accounts of the same member (e.g. FOSA -> BOSA)',
    description: 'Delegates to LedgerService.postInternalTransfer(): writes two linked Transaction rows (one per account) but exactly one JournalEntry netting the two accounts\' deposit-liability GL codes — no Cash GL account is touched since no money leaves the SACCO.',
  })
  @ApiParam({ name: 'id', description: 'Source account UUID' })
  @ApiResponse({
    status: 200,
    description: 'Transfer posted',
    schema: {
      example: {
        fromTransaction: { id: 'txn-uuid', reference: 'XFER-...-SRC' },
        toTransaction: { id: 'txn-uuid-2', reference: 'XFER-...-DST' },
        newSourceBalance: 4700,
        newDestinationBalance: 2300,
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Amount must be positive, or source/destination are the same account' })
  @ApiResponse({ status: 404, description: 'Source or destination account not found or inactive' })
  @ApiResponse({ status: 403, description: 'Source and destination accounts belong to different members' })
  transfer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferFundsDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.accounts.transfer(id, dto, tenant.id, actor.id);
  }
}
