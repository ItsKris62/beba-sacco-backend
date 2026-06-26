import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags, ApiHeader } from '@nestjs/swagger';
import { Tenant, UserRole } from '@prisma/client';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../modules/auth/strategies/jwt.strategy';
import { RepaymentService } from './repayment.service';
import { RepayFromFosaDto } from './dto/repayment.dto';

@ApiTags('Phase 2 Loan Repayments')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier for multi-tenancy', required: true })
@Controller('loan/repayments')
export class RepaymentController {
  constructor(private readonly repayments: RepaymentService) {}

  @Post('fosa')
  @Roles(UserRole.MEMBER, UserRole.TELLER, UserRole.MANAGER, UserRole.TENANT_ADMIN)
  repayFromFosa(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RepayFromFosaDto,
  ) {
    return this.repayments.repayFromFosa(tenant.id, user.id, dto.loanId, dto.amount);
  }
}
