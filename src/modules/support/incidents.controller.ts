import { Controller, Get, Post, Patch, Param, Body, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { IncidentService } from './incident.service';
import { CreateIncidentDto, LinkTicketsDto } from './dto/support.dto';
import type { Tenant } from '@prisma/client';

@ApiTags('Support Incidents')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier for multi-tenancy', required: true })
@Controller('admin/incidents')
@Roles('SUPER_ADMIN', 'TENANT_ADMIN')
export class IncidentsController {
  constructor(private readonly incidentService: IncidentService) {}

  @Get()
  async list(@CurrentTenant() tenant: Tenant, @Query() query: any) {
    return this.incidentService.listIncidents(tenant.id, query);
  }

  @Get(':id')
  async get(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.incidentService.getIncident(tenant.id, id);
  }

  @Get(':id/tickets')
  async getTickets(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.incidentService.getIncidentTickets(tenant.id, id);
  }
  @Post()
  async create(@CurrentTenant() tenant: Tenant, @Body() dto: CreateIncidentDto) {
    return this.incidentService.createIncident(tenant.id, dto);
  }

  @Patch(':id')
  async update(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: any
  ) {
    return this.incidentService.updateIncident(tenant.id, id, body);
  }

  @Post(':id/link-tickets')
  async linkTickets(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkTicketsDto
  ) {
    return this.incidentService.linkTickets(tenant.id, id, dto);
  }

  @Post(':id/notify')
  async notifyAffected(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string
  ) {
    return this.incidentService.notifyAffectedMembers(tenant.id, id);
  }
}
