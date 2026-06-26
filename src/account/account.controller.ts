import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags, ApiHeader } from '@nestjs/swagger';
import { Tenant, UserRole } from '@prisma/client';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../modules/auth/strategies/jwt.strategy';
import { AccountService } from './account.service';
import { TransferFundsDto, WithdrawDto } from './dto/account.dto';

@ApiTags('Phase 2 Accounts')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier for multi-tenancy', required: true })
@Controller('account')
export class AccountController {
  constructor(private readonly accounts: AccountService) {}

  @Get()
  @Roles(UserRole.MEMBER)
  getAccounts(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthenticatedUser) {
    return this.accounts.getAccounts(tenant.id, user.id);
  }

  @Post('transfer')
  @Roles(UserRole.MEMBER)
  transferFunds(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TransferFundsDto,
  ) {
    return this.accounts.transferFunds(
      tenant.id,
      user.id,
      dto.fromAccountType,
      dto.toAccountType,
      dto.amount,
      dto.description,
    );
  }

  @Post('withdraw')
  @Roles(UserRole.MEMBER, UserRole.TELLER, UserRole.MANAGER, UserRole.TENANT_ADMIN)
  withdraw(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WithdrawDto,
  ) {
    return this.accounts.withdraw(tenant.id, user.id, dto.accountId, dto.amount, dto.description);
  }
}

