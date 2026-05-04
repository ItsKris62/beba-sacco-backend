import { Controller, Get, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { DashboardService, DashboardStats, DashboardReports } from './dashboard.service';
import type { AuthenticatedRequest } from '../../common/types/request.types';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller('admin/dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({
    summary: 'Get dashboard KPIs',
    description: 'Returns aggregated financial KPIs. Cached in Redis for 15 minutes. Cache invalidated on new loan/repayment/savings records.',
  })
  @ApiResponse({ status: 200, description: 'Dashboard statistics' })
  async getStats(@Req() req: AuthenticatedRequest): Promise<DashboardStats> {
    return this.dashboardService.getStats(req.tenant.id);
  }

  @Get('reports')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({
    summary: 'Get dashboard reports',
    description: 'Returns loans by status, savings by week, and top defaulters.',
  })
  @ApiResponse({ status: 200, description: 'Dashboard reports' })
  async getReports(@Req() req: AuthenticatedRequest): Promise<DashboardReports> {
    return this.dashboardService.getReports(req.tenant.id);
  }
}
