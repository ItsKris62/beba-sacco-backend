import { Controller, Get, Patch, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { InAppNotificationService } from './in-app-notification.service';
import { AuthActor } from '../support/support-ticket.types';
import type { Tenant } from '@prisma/client';

@ApiTags('Notifications')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier for multi-tenancy', required: true })
@Controller('api/v1/notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: InAppNotificationService) {}

  @Get()
  async list(@CurrentTenant() tenant: Tenant, @CurrentUser() actor: AuthActor) {
    return this.notificationsService.list(tenant.id, actor.userId);
  }

  @Patch(':id/read')
  async markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthActor
  ) {
    return this.notificationsService.markRead(tenant.id, actor.userId, id);
  }
}
