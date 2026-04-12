import {
  Controller, Get, Post, Body, Param, Query,
  HttpCode, HttpStatus, ParseUUIDPipe, ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiResponse, ApiQuery, ApiHeader,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

@ApiTags('Accounts')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Post()
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Open a new BOSA or FOSA account for a member' })
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
  findAll(
    @CurrentTenant() tenant: Tenant,
    @Query('memberId') memberId?: string,
  ) {
    return this.accounts.findAll(tenant.id, memberId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get account with member info' })
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
  @ApiOperation({ summary: 'Post a manual cash deposit' })
  @ApiResponse({ status: 200, description: 'Deposit posted' })
  deposit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { amount: number; description?: string },
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const reference = `DEP-${uuidv4()}`;
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
  @ApiOperation({ summary: 'Post a cash withdrawal' })
  withdraw(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { amount: number; description?: string },
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const reference = `WDR-${uuidv4()}`;
    return this.accounts.withdraw(
      id,
      body.amount,
      reference,
      body.description ?? 'Cash withdrawal',
      tenant.id,
      actor.id,
    );
  }
}
