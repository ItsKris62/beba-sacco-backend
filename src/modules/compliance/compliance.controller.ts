import {
  Controller, Get, Patch, Query, Param, Body, Res,
  UseGuards, HttpCode, HttpStatus, Req,
} from '@nestjs/common';
import { Response, Request } from 'express';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiQuery, ApiParam, ApiResponse, ApiHeader,
} from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole, Tenant } from '@prisma/client';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { ComplianceService } from './compliance.service';
import { ExportQueryDto, ExportFormat } from './dto/export-query.dto';
import { UpdatePrivacyDto } from './dto/privacy.dto';

@ApiTags('Compliance')
@ApiBearerAuth('bearer')
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('admin/compliance')
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  // ── SASRA/CBK Export ──────────────────────────────────────────────────────

  @Get('export')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Generate SASRA/CBK compliant export',
    description:
      'Exports loan portfolio, member register, or liquidity statement in CSV or JSON. ' +
      'Mandatory for SASRA quarterly submissions.',
  })
  @ApiQuery({ name: 'type', enum: ['LOANS', 'MEMBERS', 'LIQUIDITY'] })
  @ApiQuery({ name: 'format', enum: ['CSV', 'JSON'], required: false })
  @ApiQuery({ name: 'from', required: false, example: '2025-01-01' })
  @ApiQuery({ name: 'to', required: false, example: '2025-12-31' })
  async exportData(
    @Query() query: ExportQueryDto,
    @CurrentTenant() tenant: Tenant,
    @Res() res: Response,
  ) {
    const result = await this.compliance.generateExport(
      tenant.id,
      query.type,
      query.format ?? ExportFormat.CSV,
      query.from,
      query.to,
    );

    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-Export-Type', query.type);
    res.send(result.content);
  }

  // ── Audit Chain Validation ────────────────────────────────────────────────

  @Get('audit-chain/validate')
  @Roles(UserRole.TENANT_ADMIN, UserRole.AUDITOR, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Validate immutable audit chain integrity',
    description:
      'Walks every hashed audit log entry in chronological order and verifies the SHA-256 chain. ' +
      'Returns { valid: true } when untampered, or the ID of the first broken link.',
  })
  @ApiResponse({ status: 200, description: 'Chain validation result' })
  validateAuditChain(@CurrentTenant() tenant: Tenant) {
    return this.compliance.validateAuditChain(tenant.id);
  }

  // ── Data Retention ────────────────────────────────────────────────────────

  @HttpCode(HttpStatus.OK)
  @Patch('data-retention/purge')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Run data retention purge (Kenya Data Protection Act)',
    description:
      'Soft-deletes audit logs older than DATA_RETENTION_YEARS and anonymizes PII ' +
      'for terminated members past the 5-year window.',
  })
  runPurge(@CurrentTenant() tenant: Tenant) {
    return this.compliance.runDataRetentionPurge(tenant.id);
  }

  // ── Privacy / Consent ─────────────────────────────────────────────────────

  @Patch('members/:memberId/privacy')
  @Roles(UserRole.MEMBER, UserRole.TELLER, UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @ApiOperation({
    summary: 'Update member data-sharing consent',
    description:
      'Toggles third-party data sharing consent for a member. ' +
      'Blocks all third-party exports unless consent is true.',
  })
  @ApiParam({ name: 'memberId', description: 'Member UUID' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async updatePrivacy(
    @Param('memberId') memberId: string,
    @Body() dto: UpdatePrivacyDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.compliance.updateMemberConsent(
      memberId,
      tenant.id,
      dto.consentDataSharing,
      actor.id,
      req.ip,
    );
  }

  // ── Recon Report ─────────────────────────────────────────────────────────

  @Get('recon-report')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Fetch cached M-Pesa reconciliation report for a settlement date' })
  @ApiQuery({ name: 'date', description: 'Settlement date YYYY-MM-DD', example: '2025-01-15' })
  getReconReport(
    @Query('date') date: string,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.compliance.getLatestReconReport(tenant.id, date);
  }
}
