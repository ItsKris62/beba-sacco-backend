import { Controller, Get, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { DashboardService, DashboardReports } from './dashboard.service';
import type { AuthenticatedRequest } from '../../common/types/request.types';

/**
 * `GET stats` was removed here — it collided with the canonical
 * `GET /admin/dashboard/stats` in AdminController (AdminModule imports before
 * DashboardModule in app.module.ts, so Nest/Express registered AdminController's
 * route first and this handler was dead/unreachable). Use
 * AdminService.getDashboardStats() for KPI stats; this controller now only
 * owns the non-colliding `/reports` endpoint.
 */
@ApiTags('Dashboard')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier for multi-tenancy', required: true })
@Controller('admin/dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

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
