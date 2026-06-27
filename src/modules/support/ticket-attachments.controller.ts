import { Controller, Post, Param, ParseUUIDPipe, Body } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SupportService } from './support.service';
import { AuthActor } from './support-ticket.types';
import { ConfirmUploadDto, RequestPresignDto } from './dto/support.dto';
import type { Tenant } from '@prisma/client';

@ApiTags('Support Attachments')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier for multi-tenancy', required: true })
@Controller('support/tickets/:ticketId/attachments')
export class TicketAttachmentsController {
  constructor(private readonly supportService: SupportService) {}

  @Post('presign')
  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  @Roles(UserRole.MEMBER, UserRole.LOAN_OFFICER, UserRole.MANAGER, UserRole.TENANT_ADMIN)
  async getPresignedUrl(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: RequestPresignDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthActor
  ) {
    return this.supportService.requestPresignedUpload(ticketId, tenant.id, actor, dto);
  }

  @Post('confirm')
  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  @Roles(UserRole.MEMBER, UserRole.LOAN_OFFICER, UserRole.MANAGER, UserRole.TENANT_ADMIN)
  async confirmUpload(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: ConfirmUploadDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthActor
  ) {
    return this.supportService.confirmUpload(ticketId, tenant.id, actor, dto);
  }
}






