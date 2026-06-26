import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiSecurity, ApiTags, ApiHeader } from '@nestjs/swagger';
import { Tenant, UserRole } from '@prisma/client';
import { Public } from '../common/decorators/public.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { MpesaCallbackGuard } from '../common/guards/mpesa-callback.guard';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../modules/auth/strategies/jwt.strategy';
import { StkPushDto } from './dto/stk-push.dto';
import { MpesaService } from './mpesa.service';

@ApiTags('Phase 2 M-Pesa')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier for multi-tenancy', required: true })
@Controller('mpesa')
export class MpesaController {
  constructor(
    private readonly mpesa: MpesaService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('initiate')
  @Roles(UserRole.MEMBER)
  async initiateStkPush(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StkPushDto,
  ) {
    const member = await this.prisma.member.findFirst({
      where: { tenantId: tenant.id, userId: user.id, isActive: true },
      select: { id: true },
    });
    if (!member) throw new Error('Member profile not found');
    return this.mpesa.initiateStkPush(member.id, dto.amount, 'FOSA deposit');
  }

  @Public()
  @UseGuards(MpesaCallbackGuard)
  @Post('callback')
  @ApiExcludeEndpoint()
  handleCallback(@Body() payload: any) {
    return this.mpesa.handleCallback(payload);
  }
}


