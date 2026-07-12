import { BadRequestException, Controller, Get, Query, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  DashboardService,
  DashboardReports,
  type DelinquencyTrends,
  type DashboardDrilldownResponse,
  type ExecutiveOverview,
  type ExecutiveOverviewRange,
  type GuarantorCorrelationResponse,
  type GuarantorHealth,
  type MpesaHeatmap,
} from './dashboard.service';
import {
  DashboardDrilldownQueryDto,
  DelinquencyTrendsQueryDto,
  GuarantorCorrelationQueryDto,
} from './dto/dashboard-drilldown.dto';
import type { AuthenticatedRequest } from '../../common/types/request.types';

const VALID_RANGES: ExecutiveOverviewRange[] = ['30d', '90d', '1y'];

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

  private requireTenantContext(req: AuthenticatedRequest): string {
    const tenantId = req.tenant?.id;
    if (!tenantId) {
      throw new BadRequestException('Tenant context is required. Select a tenant before using dashboard analytics.');
    }
    return tenantId;
  }

  @Get('reports')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({
    summary: 'Get dashboard reports',
    description:
      'Returns loans by status, savings by week, top defaulters, loan product mix, and SASRA-style arrears aging buckets.',
  })
  @ApiResponse({ status: 200, description: 'Dashboard reports' })
  async getReports(@Req() req: AuthenticatedRequest): Promise<DashboardReports> {
    return this.dashboardService.getReports(req.tenant.id);
  }

  @Get('executive-overview')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({
    summary: 'Get executive overview trends',
    description:
      'Returns daily (or weekly, for 1y) revenue/disbursement/new-member time series. No delinquency series — this schema has no historical PAR snapshot to trend.',
  })
  @ApiResponse({ status: 200, description: 'Executive overview time series' })
  async getExecutiveOverview(
    @Req() req: AuthenticatedRequest,
    @Query('range') range = '30d',
  ): Promise<ExecutiveOverview> {
    if (!VALID_RANGES.includes(range as ExecutiveOverviewRange)) {
      throw new BadRequestException(`range must be one of: ${VALID_RANGES.join(', ')}`);
    }
    return this.dashboardService.getExecutiveOverview(req.tenant.id, range as ExecutiveOverviewRange);
  }

  @Get('guarantor-health')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({
    summary: 'Get guarantor network health',
    description: 'Returns guarantee coverage breakdown and guarantor default-rate for the active loan book.',
  })
  @ApiResponse({ status: 200, description: 'Guarantor network health' })
  async getGuarantorHealth(@Req() req: AuthenticatedRequest): Promise<GuarantorHealth> {
    return this.dashboardService.getGuarantorHealth(req.tenant.id);
  }

  @Get('mpesa-heatmap')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({
    summary: 'Get M-Pesa deposit heatmap',
    description: 'Returns completed M-Pesa deposit volume bucketed by day and hour over the requested window.',
  })
  @ApiResponse({ status: 200, description: 'M-Pesa deposit heatmap buckets' })
  async getMpesaHeatmap(@Req() req: AuthenticatedRequest, @Query('days') days = '7'): Promise<MpesaHeatmap> {
    const parsed = parseInt(days, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 30) {
      throw new BadRequestException('days must be an integer between 1 and 30');
    }
    return this.dashboardService.getMpesaHeatmap(req.tenant.id, parsed);
  }

  @Get('delinquency-trends')
  @HttpCode(HttpStatus.OK)
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.MANAGER,
    UserRole.LOAN_OFFICER,
    UserRole.AUDITOR,
  )
  @ApiOperation({
    summary: 'Get delinquency trend lines',
    description:
      'Returns tenant-scoped daily arrears snapshot aggregates over a date range, optionally filtered by loan product.',
  })
  @ApiResponse({ status: 200, description: 'Delinquency trend time series' })
  async getDelinquencyTrends(
    @Req() req: AuthenticatedRequest,
    @Query() query: DelinquencyTrendsQueryDto,
  ): Promise<DelinquencyTrends> {
    return this.dashboardService.getDelinquencyTrends(this.requireTenantContext(req), query);
  }

  @Get('guarantor-correlation')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({
    summary: 'Get guarantor default correlation analysis',
    description:
      'Returns tenant-scoped accepted-guarantee counts by guarantor and ranks guarantors with enough guarantees by default correlation rate.',
  })
  @ApiResponse({ status: 200, description: 'Guarantor default correlation analysis' })
  async getGuarantorCorrelation(
    @Req() req: AuthenticatedRequest,
    @Query() query: GuarantorCorrelationQueryDto,
  ): Promise<GuarantorCorrelationResponse> {
    return this.dashboardService.getGuarantorCorrelation(this.requireTenantContext(req), query);
  }

  @Get('drilldown')
  @HttpCode(HttpStatus.OK)
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.MANAGER,
    UserRole.LOAN_OFFICER,
    UserRole.AUDITOR,
  )
  @ApiOperation({
    summary: 'Get dashboard chart drill-down rows',
    description:
      'Returns tenant-scoped paginated rows for dashboard chart segments across transactions, M-Pesa, loans, guarantors, members, and journal entries.',
  })
  @ApiResponse({ status: 200, description: 'Dashboard drill-down rows' })
  async getDrilldown(
    @Req() req: AuthenticatedRequest,
    @Query() query: DashboardDrilldownQueryDto,
  ): Promise<DashboardDrilldownResponse> {
    return this.dashboardService.getDrilldown(this.requireTenantContext(req), query);
  }
}
