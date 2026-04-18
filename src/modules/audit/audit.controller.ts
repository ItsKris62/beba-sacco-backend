import {
  Controller, Get, Query, UseGuards,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiResponse, ApiQuery, ApiHeader,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AuditService } from './audit.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import type { Tenant } from '@prisma/client';

@ApiTags('Audit')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @ApiOperation({
    summary: 'List audit logs',
    description:
      'Returns paginated audit logs for the current tenant. ' +
      'Accessible by TENANT_ADMIN, MANAGER, and AUDITOR roles.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiQuery({ name: 'action', required: false, type: String, example: 'AUTH.LOGIN' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiResponse({ status: 200, description: 'Paginated audit log entries' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden – insufficient role' })
  findAll(
    @CurrentTenant() tenant: Tenant,
    @Query('page') page = 1,
    @Query('limit') limit = 50,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const safePage = Math.max(1, Number(page));
    const safeLimit = Math.min(200, Math.max(1, Number(limit)));
    const offset = (safePage - 1) * safeLimit;

    const fromDate = from ? new Date(from) : undefined;
    let toDate: Date | undefined;
    if (to) {
      toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
    }

    return this.auditService.findAll({
      tenantId: tenant.id,
      action,
      fromDate,
      toDate,
      limit: safeLimit,
      offset,
    }).then((result) => ({
      success: true,
      data: result.data,
      meta: {
        page: safePage,
        limit: safeLimit,
        total: result.total,
        totalPages: Math.ceil(result.total / safeLimit),
      },
      error: null,
    }));
  }
}
