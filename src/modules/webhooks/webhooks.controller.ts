import {
  Controller, Get, Post, Delete, Patch, Body, Param, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiParam, ApiResponse, ApiHeader,
} from '@nestjs/swagger';
import { UserRole, Tenant, WebhookStatus } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { WebhooksService } from './webhooks.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';

@ApiTags('Integrations')
@ApiBearerAuth('bearer')
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('admin/integrations/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post()
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Create outbound webhook subscription',
    description:
      'Subscribe to SACCO events (loan.status_changed, repayment.posted, kyc.updated, …). ' +
      'Events are delivered via POST with HMAC-SHA256 signature in X-Beba-Signature header.',
  })
  @ApiResponse({ status: 201, description: 'Subscription created. Secret returned once — store it securely.' })
  create(@Body() dto: CreateWebhookDto, @CurrentTenant() tenant: Tenant) {
    return this.webhooks.create(tenant.id, dto);
  }

  @Get()
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'List webhook subscriptions' })
  list(@CurrentTenant() tenant: Tenant) {
    return this.webhooks.list(tenant.id);
  }

  @Delete(':id')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a webhook subscription' })
  @ApiParam({ name: 'id', description: 'Subscription UUID' })
  delete(@Param('id') id: string, @CurrentTenant() tenant: Tenant) {
    return this.webhooks.delete(id, tenant.id);
  }

  @Patch(':id/disable')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Disable a webhook subscription (keep record)' })
  @ApiParam({ name: 'id', description: 'Subscription UUID' })
  disable(@Param('id') id: string, @CurrentTenant() tenant: Tenant) {
    return this.webhooks.setStatus(id, tenant.id, WebhookStatus.INACTIVE);
  }

  @Patch(':id/enable')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Re-enable a disabled webhook subscription' })
  @ApiParam({ name: 'id', description: 'Subscription UUID' })
  enable(@Param('id') id: string, @CurrentTenant() tenant: Tenant) {
    return this.webhooks.setStatus(id, tenant.id, WebhookStatus.ACTIVE);
  }

  @Get(':id/deliveries')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Recent delivery log for a subscription (last 50)' })
  @ApiParam({ name: 'id', description: 'Subscription UUID' })
  deliveries(@Param('id') id: string, @CurrentTenant() tenant: Tenant) {
    return this.webhooks.getDeliveries(id, tenant.id);
  }
}
