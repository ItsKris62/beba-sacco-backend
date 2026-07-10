import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { Tenant, UserRole } from '@prisma/client';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { GetNotificationLogsDto } from '../dto/get-notification-logs.dto';
import { AdminNotificationsService } from '../services/admin-notifications.service';

@ApiTags('Admin Notifications')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('admin/notifications')
@Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER)
export class AdminNotificationsController {
  constructor(private readonly adminNotificationsService: AdminNotificationsService) {}

  @Get('logs')
  @ApiOperation({ summary: 'List tenant-scoped notification audit logs' })
  @ApiResponse({ status: 200, description: 'Paginated notification audit logs' })
  getLogs(
    @CurrentTenant() tenant: Tenant,
    @Query() query: GetNotificationLogsDto,
  ) {
    return this.adminNotificationsService.getLogs(tenant.id, query);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry a failed notification' })
  @ApiParam({ name: 'id', description: 'NotificationLog UUID' })
  @ApiResponse({ status: 200, description: 'Notification retry queued and log reset to PENDING' })
  @ApiResponse({ status: 404, description: 'Notification log not found for this tenant' })
  @ApiResponse({ status: 409, description: 'Notification is not FAILED or retry is already pending' })
  retryNotification(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminNotificationsService.retryNotification(tenant.id, id);
  }
}
