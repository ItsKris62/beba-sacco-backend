import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';
import { GenerateReportDto } from './dto/generate-report.dto';
import { ReportsService } from './reports.service';

@ApiTags('Reports')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
@Controller('admin/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post('generate')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Queue an async tenant-scoped report export' })
  @ApiResponse({ status: 202, description: 'Report job queued' })
  async generate(
    @Body() dto: GenerateReportDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reports.generateReport(dto, tenant.id, user.id);
  }

  @Get(':jobId/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get report generation status' })
  @ApiParam({ name: 'jobId', description: 'Report job UUID' })
  async status(@Param('jobId') jobId: string, @CurrentTenant() tenant: Tenant) {
    return this.reports.getStatus(jobId, tenant.id);
  }

  @Get(':jobId/download')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get a tenant-scoped pre-signed report download URL' })
  @ApiParam({ name: 'jobId', description: 'Report job UUID' })
  async download(
    @Param('jobId') jobId: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reports.getDownloadUrl(jobId, tenant.id, user.id);
  }
}
