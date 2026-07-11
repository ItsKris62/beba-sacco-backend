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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

@ApiTags('Audit')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
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
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, description: 'Deprecated; use cursor' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiQuery({ name: 'action', required: false, type: String, example: 'AUTH.LOGIN' })
  @ApiQuery({ name: 'entityType', required: false, type: String, example: 'Loan' })
  @ApiQuery({ name: 'actorId', required: false, type: String })
  @ApiQuery({ name: 'entityId', required: false, type: String })
  @ApiQuery({ name: 'ipAddress', required: false, type: String })
  @ApiQuery({ name: 'userAgent', required: false, type: String })
  @ApiQuery({ name: 'tenantId', required: false, type: String, description: 'SUPER_ADMIN only tenant filter' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiResponse({ status: 200, description: 'Paginated audit log entries' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden – insufficient role' })
  findAll(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 50,
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('actorId') actorId?: string,
    @Query('entityId') entityId?: string,
    @Query('ipAddress') ipAddress?: string,
    @Query('userAgent') userAgent?: string,
    @Query('tenantId') queryTenantId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const safePage = Math.max(1, Number(page));
    const safeLimit = Math.min(200, Math.max(1, Number(limit)));

    const fromDate = from ? new Date(from) : undefined;
    let toDate: Date | undefined;
    if (to) {
      toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
    }

    const isSuperAdmin = user.role === UserRole.SUPER_ADMIN;

    return this.auditService.findAll({
      tenantId: isSuperAdmin ? queryTenantId : tenant.id,
      actorId,
      action,
      entityType,
      entityId,
      ipAddress,
      userAgent,
      fromDate,
      toDate,
      limit: safeLimit,
      cursor,
      crossTenant: isSuperAdmin,
    }).then((result) => ({
      data: result.data,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      meta: { limit: safeLimit, cursor: cursor ?? null, nextCursor: result.nextCursor, hasMore: result.hasMore },
    }));
  }
  @Get('export')
  @ApiOperation({
    summary: 'Export audit logs',
    description:
      'Exports the filtered tenant audit trail as CSV or PDF. SUPER_ADMIN, TENANT_ADMIN, MANAGER, and AUDITOR have full tenant audit access.',
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'pdf'] })
  @ApiQuery({ name: 'action', required: false, type: String })
  @ApiQuery({ name: 'entityType', required: false, type: String })
  @ApiQuery({ name: 'actorId', required: false, type: String })
  @ApiQuery({ name: 'entityId', required: false, type: String })
  @ApiQuery({ name: 'ipAddress', required: false, type: String })
  @ApiQuery({ name: 'userAgent', required: false, type: String })
  @ApiQuery({ name: 'tenantId', required: false, type: String, description: 'SUPER_ADMIN only tenant filter' })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  async exportAuditLogs(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
    @Query('format') format: 'csv' | 'pdf' = 'csv',
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('actorId') actorId?: string,
    @Query('entityId') entityId?: string,
    @Query('ipAddress') ipAddress?: string,
    @Query('userAgent') userAgent?: string,
    @Query('tenantId') queryTenantId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<void> {
    const fromDate = from ? new Date(from) : undefined;
    let toDate: Date | undefined;
    if (to) {
      toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
    }

    const isSuperAdmin = user.role === UserRole.SUPER_ADMIN;
    const entries = await this.auditService.findForExport({
      tenantId: isSuperAdmin ? queryTenantId : tenant.id,
      actorId,
      action,
      entityType,
      entityId,
      ipAddress,
      userAgent,
      fromDate,
      toDate,
      limit: 5000,
      crossTenant: isSuperAdmin,
    });

    await this.auditService.create({
      tenantId: tenant.id,
      actorId: user.id,
      action: 'AUDIT.EXPORT',
      entityType: 'AuditLog',
      metadata: { format, filters: { action, entityType, actorId, entityId, ipAddress, userAgent, tenantId: queryTenantId, from, to }, rowCount: entries.length },
    });

    const suffix = `${from ?? 'start'}-to-${to ?? 'now'}`;
    if (format === 'pdf') {
      const pdf = await this.auditService.exportAsPdf(entries);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="audit-trail-${suffix}.pdf"`);
      res.setHeader('Content-Length', pdf.length);
      res.end(pdf);
      return;
    }

    const csv = this.auditService.exportAsCsv(entries);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-trail-${suffix}.csv"`);
    res.send(csv);
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

@ApiTags('Admin Audit')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
@Controller('admin/audit-logs')
export class AdminAuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @ApiOperation({
    summary: 'List audit logs for admins',
    description:
      'Admin compatibility endpoint for paginated audit visibility (M-Pesa reconciliations, ' +
      'loan approvals/disbursements, and every other audited action). ' +
      'Accessible to SUPER_ADMIN, TENANT_ADMIN, MANAGER, and AUDITOR roles. ' +
      'Strictly scoped to the caller\'s tenantId except for SUPER_ADMIN, which may pass ' +
      '?tenantId= to inspect a specific tenant.',
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, description: 'Deprecated; use cursor' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiQuery({ name: 'userId', required: false, type: String })
  @ApiQuery({ name: 'action', required: false, type: String, example: 'LOAN.APPLY' })
  @ApiQuery({ name: 'startDate', required: false, type: String, description: 'ISO date or datetime' })
  @ApiQuery({ name: 'endDate', required: false, type: String, description: 'ISO date or datetime' })
  @ApiResponse({ status: 200, description: 'Paginated audit log entries' })
  findAdminAuditLogs(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 50,
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('ipAddress') ipAddress?: string,
    @Query('userAgent') userAgent?: string,
    @Query('tenantId') queryTenantId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const safePage = Math.max(1, Number(page));
    const safeLimit = Math.min(200, Math.max(1, Number(limit)));

    const fromDate = startDate ? new Date(startDate) : undefined;
    const toDate = endDate ? new Date(endDate) : undefined;
    if (toDate && endDate && !endDate.includes('T')) {
      toDate.setHours(23, 59, 59, 999);
    }

    const isSuperAdmin = user.role === UserRole.SUPER_ADMIN;

    return this.auditService
      .findAll({
        tenantId: isSuperAdmin ? queryTenantId : tenant.id,
        actorId: userId,
        action,
        entityType,
        entityId,
        ipAddress,
        userAgent,
        fromDate,
        toDate,
        limit: safeLimit,
        cursor,
        crossTenant: isSuperAdmin,
      })
      .then((result) => ({
        data: result.data,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
        meta: { limit: safeLimit, cursor: cursor ?? null, nextCursor: result.nextCursor, hasMore: result.hasMore },
      }));
  }
}
