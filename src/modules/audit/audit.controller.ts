import {
  Controller, Get, Query, Res, UseGuards,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiResponse, ApiQuery, ApiHeader,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { Response } from 'express';
import { AuditService } from './audit.service';
import { SasraValidatorService } from './sasra-validator.service';
import { SasraAuditQueryDto, SasraAuditReport } from './dto/sasra-audit.dto';
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
  constructor(
    private readonly auditService: AuditService,
    private readonly sasraValidator: SasraValidatorService,
  ) {}

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


  // ─── SASRA M-Pesa Audit Report ────────────────────────────────────────────

  @Get('sasra/mpesa')
  @Roles(UserRole.TENANT_ADMIN, UserRole.AUDITOR, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'SASRA M-Pesa audit trail validation report',
    description:
      'Validates all MpesaTransaction rows in the given date window against ' +
      'SASRA/CBK audit rules. Checks: required field completeness, timestamp skew, ' +
      'ledger cross-validation, stale PENDING detection, and DLQ count.\n\n' +
      'Set ?format=csv to download a UTF-8 CSV for Excel/Google Sheets.\n\n' +
      '⚠️ Phone numbers are masked (254***XXXX) in all outputs per ODPC mandate.',
  })
  @ApiQuery({ name: 'startDate', required: true, example: '2026-04-01' })
  @ApiQuery({ name: 'endDate', required: true, example: '2026-04-30' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'json (default) or csv' })
  @ApiResponse({ status: 200, description: 'SASRA audit report', type: SasraAuditReport })
  @ApiResponse({ status: 400, description: 'Invalid date range' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  async sasraMpesaAudit(
    @CurrentTenant() tenant: Tenant,
    @Query() query: SasraAuditQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SasraAuditReport | void> {
    const startDate = new Date(`${query.startDate}T00:00:00.000+03:00`);
    const endDate = new Date(`${query.endDate}T23:59:59.999+03:00`);

    const report = await this.sasraValidator.validateMpesaAuditTrail(
      startDate,
      endDate,
      tenant.id,
    );

    if (query.format === 'csv') {
      const csv = this.sasraValidator.exportAsCsv(report);
      const filename = `sasra-mpesa-audit-${query.startDate}-to-${query.endDate}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
      return;
    }

    return report;
  }
}
