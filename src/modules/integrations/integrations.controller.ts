import {
  Controller, Get, Post, Query, Body, Res, Param,
  HttpCode, HttpStatus, Req,
} from '@nestjs/common';
import { Response, Request } from 'express';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiQuery, ApiResponse, ApiHeader,
} from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { UserRole, Tenant } from '@prisma/client';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

import { CrbService } from './crb/crb.service';
import { AmlService } from './aml/aml.service';
import { Ifrs9EclService } from './ifrs9/ifrs9-ecl.service';
import { SasraRatiosService } from './sasra/sasra-ratios.service';
import { DsarService } from './dsar/dsar.service';
import { CbkReturnService } from './cbk/cbk-return.service';
import { ApiGatewayService } from './gateway/api-gateway.service';
import {
  CreateCrbReportDto,
  CreateAmlScreeningDto,
  CreateDsarRequestDto,
  RegisterApiClientDto,
  TokenExchangeDto,
} from './dto/integration.dto';

// ─────────────────────────────────────────────────────────────────────────────
// CRB Integration Controller
// ─────────────────────────────────────────────────────────────────────────────

@ApiTags('Integrations – CRB')
@ApiBearerAuth('bearer')
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true })
@Controller('integrations/crb')
export class CrbController {
  constructor(private readonly crb: CrbService) {}

  @Post('report')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Create CRB report',
    description: 'Maps loan data to CRB Africa/Metropol XML format and queues for submission via outbox pattern.',
  })
  @ApiResponse({ status: 201, description: 'CRB report queued' })
  createReport(@Body() dto: CreateCrbReportDto, @CurrentTenant() tenant: Tenant) {
    return this.crb.createReport({
      tenantId: tenant.id,
      loanIds: dto.loanIds,
      periodStart: dto.periodStart,
      periodEnd: dto.periodEnd,
    });
  }

  @Get('reports')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'List CRB report history' })
  getReports(@CurrentTenant() tenant: Tenant) {
    return this.crb.getReports(tenant.id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AML/CFT Screening Controller
// ─────────────────────────────────────────────────────────────────────────────

@ApiTags('Integrations – AML/CFT')
@ApiBearerAuth('bearer')
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true })
@Controller('integrations/aml')
export class AmlController {
  constructor(private readonly aml: AmlService) {}

  @Post('screen')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Initiate AML/CFT screening',
    description: 'Screens member against UN/EU/OFAC sanctions and PEP lists. Returns riskScore and status.',
  })
  @ApiResponse({ status: 201, description: 'Screening initiated' })
  initiateScreening(@Body() dto: CreateAmlScreeningDto, @CurrentTenant() tenant: Tenant) {
    return this.aml.initiateScreening({
      tenantId: tenant.id,
      memberId: dto.memberId,
      trigger: dto.trigger,
      triggerRef: dto.triggerRef,
    });
  }

  @Get('screenings')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'List AML screenings' })
  @ApiQuery({ name: 'memberId', required: false })
  getScreenings(@CurrentTenant() tenant: Tenant, @Query('memberId') memberId?: string) {
    return this.aml.getScreenings(tenant.id, memberId);
  }

  @Get('screenings/:id')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get AML screening result' })
  getScreening(@Param('id') id: string, @CurrentTenant() tenant: Tenant) {
    return this.aml.getScreening(id, tenant.id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compliance – IFRS 9, SASRA, DSAR, CBK Return
// ─────────────────────────────────────────────────────────────────────────────

@ApiTags('Compliance – Phase 5')
@ApiBearerAuth('bearer')
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true })
@Controller('admin/compliance')
export class CompliancePhase5Controller {
  constructor(
    private readonly ifrs9: Ifrs9EclService,
    private readonly sasra: SasraRatiosService,
    private readonly dsar: DsarService,
    private readonly cbk: CbkReturnService,
  ) {}

  // ── IFRS 9 ECL ────────────────────────────────────────────────────────────

  @Get('ifrs9-ecl')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Get IFRS 9 ECL provisioning entries',
    description: 'Calculates PD×LGD×EAD for each loan. Returns provisioning entries and summary.',
  })
  @ApiQuery({ name: 'date', required: false, example: '2025-01-15' })
  @ApiQuery({ name: 'staging', required: false, enum: ['PERFORMING', 'WATCHLIST', 'NPL'] })
  getEcl(
    @CurrentTenant() tenant: Tenant,
    @Query('date') date?: string,
    @Query('staging') staging?: string,
  ) {
    return this.ifrs9.getProvisioningEntries(tenant.id, date, staging);
  }

  @Post('ifrs9-ecl/calculate')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger IFRS 9 ECL calculation for today' })
  calculateEcl(@CurrentTenant() tenant: Tenant) {
    const today = new Date().toISOString().split('T')[0];
    return this.ifrs9.calculateEclForTenant(tenant.id, today);
  }

  @Get('ifrs9-ecl/trend')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get ECL trend over time' })
  @ApiQuery({ name: 'days', required: false, example: 30 })
  getEclTrend(@CurrentTenant() tenant: Tenant, @Query('days') days?: number) {
    return this.ifrs9.getEclTrend(tenant.id, days ?? 30);
  }

  // ── SASRA Ratios ──────────────────────────────────────────────────────────

  @Get('sasra-ratios')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Get SASRA liquidity & capital ratios',
    description: 'Computes Liquidity Ratio, Capital Adequacy, Portfolio Quality. Returns CBK-formatted JSON with trend.',
  })
  @ApiQuery({ name: 'period', required: false, example: '2025-01' })
  getSasraRatios(@CurrentTenant() tenant: Tenant, @Query('period') period?: string) {
    return this.sasra.computeRatios(tenant.id, period);
  }

  // ── DSAR ──────────────────────────────────────────────────────────────────

  @Post('dsar/request')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Create Data Subject Access Request',
    description: 'Aggregates all PII for a member. Returns encrypted ZIP download URL (expires in 30 days).',
  })
  @ApiResponse({ status: 201, description: 'DSAR completed' })
  createDsar(
    @Body() dto: CreateDsarRequestDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dsar.createRequest({
      tenantId: tenant.id,
      memberId: dto.memberId,
      requestedBy: user.id,
    });
  }

  @Get('dsar/requests')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'List DSAR requests' })
  @ApiQuery({ name: 'memberId', required: false })
  listDsarRequests(@CurrentTenant() tenant: Tenant, @Query('memberId') memberId?: string) {
    return this.dsar.listRequests(tenant.id, memberId);
  }

  // ── CBK Return ────────────────────────────────────────────────────────────

  @Get('cbk-return')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Generate CBK monthly return',
    description: 'Produces CBK monthly filing CSV with LOAN_PORTFOLIO, NPL_RATIO, DEPOSIT_GROWTH, CAPITAL_ADEQUACY.',
  })
  @ApiQuery({ name: 'period', required: true, example: '2025-01' })
  async getCbkReturn(
    @Query('period') period: string,
    @CurrentTenant() tenant: Tenant,
    @Res() res: Response,
  ) {
    const result = await this.cbk.generateReturn(tenant.id, period);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="cbk_return_${period}_v${result.version}.csv"`);
    res.send(result.csv);
  }

  @Get('cbk-return/history')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'List historical CBK returns' })
  getCbkReturnHistory(@CurrentTenant() tenant: Tenant) {
    return this.cbk.getReturns(tenant.id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Open API Gateway Controller
// ─────────────────────────────────────────────────────────────────────────────

@ApiTags('API Gateway')
@Controller('admin/integrations')
export class ApiGatewayController {
  constructor(private readonly gateway: ApiGatewayService) {}

  @Post('api-clients')
  @ApiBearerAuth('bearer')
  @ApiSecurity('X-Tenant-ID')
  @ApiHeader({ name: 'X-Tenant-ID', required: true })
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Register API client (partner)' })
  registerClient(@Body() dto: RegisterApiClientDto, @CurrentTenant() tenant: Tenant) {
    return this.gateway.registerClient({ tenantId: tenant.id, ...dto });
  }

  @Get('api-clients')
  @ApiBearerAuth('bearer')
  @ApiSecurity('X-Tenant-ID')
  @ApiHeader({ name: 'X-Tenant-ID', required: true })
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'List API clients' })
  listClients(@CurrentTenant() tenant: Tenant) {
    return this.gateway.listClients(tenant.id);
  }

  @Post('oauth/token')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'OAuth2 token exchange (client_credentials)',
    description: 'Exchange client_id + client_secret for an access token.',
  })
  issueToken(@Body() dto: TokenExchangeDto) {
    const scopes = dto.scope ? dto.scope.split(' ') : undefined;
    return this.gateway.issueToken(dto.client_id, dto.client_secret, scopes);
  }
  // NOTE: Webhook registration is handled by WebhooksController (POST /webhooks).
  // Removed duplicate registerWebhook method to avoid route collision.
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitoring – Liquidity Ratios (real-time dashboard feed)
// ─────────────────────────────────────────────────────────────────────────────

@ApiTags('Monitoring')
@ApiBearerAuth('bearer')
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true })
@Controller('admin/monitoring')
export class MonitoringController {
  constructor(private readonly sasra: SasraRatiosService) {}

  @Get('liquidity-ratios')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Real-time liquidity ratio dashboard feed' })
  getLiquidityRatios(@CurrentTenant() tenant: Tenant) {
    return this.sasra.computeRatios(tenant.id);
  }
}
