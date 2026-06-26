import { Body, Controller, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags, ApiHeader } from '@nestjs/swagger';
import { Tenant, UserRole } from '@prisma/client';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../modules/auth/strategies/jwt.strategy';
import { GuarantorService } from './guarantor.service';
import { RequestGuarantorDto, RespondToGuarantorRequestDto } from './dto/guarantor.dto';

@ApiTags('Phase 2 Guarantors')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier for multi-tenancy', required: true })
@Controller('loan/guarantors')
export class GuarantorController {
  constructor(private readonly guarantors: GuarantorService) {}

  @Post('request')
  @Roles(UserRole.MEMBER, UserRole.LOAN_OFFICER, UserRole.MANAGER, UserRole.TENANT_ADMIN)
  requestGuarantor(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestGuarantorDto,
  ) {
    return this.guarantors.requestGuarantor(tenant.id, user.id, dto.loanId, dto.guarantorMemberId);
  }

  @Patch(':id/respond')
  @Roles(UserRole.MEMBER)
  respondToRequest(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondToGuarantorRequestDto,
  ) {
    return this.guarantors.respondToRequest(tenant.id, user.id, id, dto.action, dto.notes);
  }
}
