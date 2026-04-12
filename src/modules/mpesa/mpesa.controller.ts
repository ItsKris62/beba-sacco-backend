import {
  Controller, Post, Body, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation, ApiResponse, ApiHeader,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { MpesaService } from './mpesa.service';
import { StkPushDto } from './dto/stk-push.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

@ApiTags('M-Pesa')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('mpesa')
export class MpesaController {
  constructor(private readonly mpesaService: MpesaService) {}

  @Post('stk-push')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Initiate an M-Pesa STK Push',
    description:
      'Sends a payment prompt to the customer\'s phone. ' +
      'The result is delivered asynchronously via the STK callback webhook. ' +
      'Use accountReference to specify the account to credit (account number).',
  })
  @ApiResponse({ status: 200, description: 'STK Push initiated' })
  @ApiResponse({ status: 400, description: 'Invalid phone number or callback URL not configured' })
  stkPush(
    @Body() dto: StkPushDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.mpesaService.stkPush(dto, tenant.id, actor.id);
  }
}
