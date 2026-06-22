import { Controller, Post, Param, ParseUUIDPipe, Body } from '@nestjs/common';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupportService } from './support.service';
import { AuthActor } from './support-ticket.types';
import { RequestPresignDto } from './dto/support.dto';
import type { Tenant } from '@prisma/client';

@Controller('api/v1/support/tickets/:ticketId/attachments')
export class TicketAttachmentsController {
  constructor(private readonly supportService: SupportService) {}

  @Post('presign')
  async getPresignedUrl(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: RequestPresignDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthActor
  ) {
    return this.supportService.requestPresignedUpload(ticketId, tenant.id, actor, dto);
  }
}
