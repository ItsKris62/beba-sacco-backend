import { Controller, Get, UseGuards, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { DashboardService, DashboardStats, DashboardReports } from './dashboard.service';
import type { AuthenticatedRequest } from '../../common/types/request.types';

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  @HttpCode(HttpStatus.OK)
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN', 'MANAGER', 'AUDITOR')
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
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN', 'MANAGER', 'AUDITOR')
  @ApiOperation({
    summary: 'Get dashboard reports',
    description: 'Returns loans by status, savings by week, and top defaulters.',
  })
  @ApiResponse({ status: 200, description: 'Dashboard reports' })
  async getReports(@Req() req: AuthenticatedRequest): Promise<DashboardReports> {
    return this.dashboardService.getReports(req.tenant.id);
  }
}
