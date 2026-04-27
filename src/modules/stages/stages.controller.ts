import {
  Controller, Get, Post, Patch, Delete, Param, Body,
  Query, HttpCode, HttpStatus, Req,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiResponse, ApiQuery, ApiHeader, ApiBody,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { StagesService } from './stages.service';
import { CreateStageDto, UpdateStageDto, AssignStagePositionDto } from './dto/create-stage.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

@ApiTags('Stages')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('admin/stages')
export class StagesController {
  constructor(private readonly stagesService: StagesService) {}

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new boda boda stage' })
  @ApiBody({ type: CreateStageDto })
  @ApiResponse({ status: 201, description: 'Stage created' })
  @ApiResponse({ status: 409, description: 'Stage already exists in this ward' })
  create(
    @Body() dto: CreateStageDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.stagesService.create(dto, tenant.id, actor.id, req.ip);
  }

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'List all stages for this tenant (with optional location filters)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'countyId', required: false, type: String, description: 'Filter by county' })
  @ApiQuery({ name: 'constituencyId', required: false, type: String, description: 'Filter by constituency/sub-county' })
  @ApiQuery({ name: 'wardId', required: false, type: String, description: 'Filter by ward' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Search by stage name' })
  @ApiResponse({ status: 200, description: 'Paginated stage list' })
  findAll(
    @CurrentTenant() tenant: Tenant,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('countyId') countyId?: string,
    @Query('constituencyId') constituencyId?: string,
    @Query('wardId') wardId?: string,
    @Query('search') search?: string,
  ) {
    // If any location filter is provided, use the location-aware query
    if (countyId || constituencyId || wardId || search) {
      return this.stagesService.findByLocation(tenant.id, { page, limit, countyId, constituencyId, wardId, search });
    }
    return this.stagesService.findAll(tenant.id, { page, limit });
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'Get stage details with active assignments' })
  @ApiResponse({ status: 200, description: 'Stage details' })
  @ApiResponse({ status: 404, description: 'Stage not found' })
  findOne(@Param('id') id: string, @CurrentTenant() tenant: Tenant) {
    return this.stagesService.findOne(id, tenant.id);
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a stage name or ward mapping' })
  @ApiBody({ type: UpdateStageDto })
  @ApiResponse({ status: 200, description: 'Stage updated' })
  @ApiResponse({ status: 404, description: 'Stage not found' })
  @ApiResponse({ status: 409, description: 'Stage name already exists in this ward' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateStageDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.stagesService.update(id, dto, tenant.id, actor.id, req.ip);
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a stage (only if no active assignments)' })
  @ApiResponse({ status: 200, description: 'Stage deleted' })
  @ApiResponse({ status: 400, description: 'Stage has active assignments' })
  @ApiResponse({ status: 404, description: 'Stage not found' })
  remove(
    @Param('id') id: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.stagesService.remove(id, tenant.id, actor.id, req.ip);
  }

  @Post(':id/assign')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assign a user to a stage position',
    description:
      'Assigns CHAIRMAN, SECRETARY, TREASURER, or MEMBER. ' +
      'Assigning CHAIRMAN/SECRETARY deactivates the previous holder.',
  })
  @ApiBody({ type: AssignStagePositionDto })
  @ApiResponse({ status: 200, description: 'Assignment created/updated' })
  assignPosition(
    @Param('id') id: string,
    @Body() dto: AssignStagePositionDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.stagesService.assignPosition(id, dto, tenant.id, actor.id, req.ip);
  }
}
