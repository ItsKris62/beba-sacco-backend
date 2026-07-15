import { Controller, Get, Patch, Post, Body, Req } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { Request } from 'express';
import { Tenant, UserRole } from '@prisma/client';
import { TenantsService } from './tenants.service';
import { UpdateTenantSettingsDto } from './dto/update-tenant-settings.dto';
import { RequestLogoUploadUrlDto } from './dto/request-logo-upload-url.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

// Note: JwtAuthGuard + RBACGuard are registered globally via APP_GUARD in app.module.ts
// (see LoansController for the same convention) — no local @UseGuards() needed here.
@ApiTags('Tenants')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier for multi-tenancy', required: true })
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get('settings')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get current tenant settings' })
  async getSettings(@CurrentTenant() tenant: Tenant) {
    return this.tenantsService.getSettings(tenant.id);
  }

  @Patch('settings')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update tenant settings' })
  async updateSettings(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: UpdateTenantSettingsDto,
    @Req() req: Request,
  ) {
    return this.tenantsService.updateSettings(tenant.id, dto, actor.id, req.ip);
  }

  @Post('logo/upload-url')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get a pre-signed URL to upload a new organization logo' })
  async requestLogoUploadUrl(
    @CurrentTenant() tenant: Tenant,
    @Body() dto: RequestLogoUploadUrlDto,
  ) {
    return this.tenantsService.requestLogoUploadUrl(tenant.id, dto);
  }

  @Get('public-info')
  @Public()
  @ApiOperation({
    summary: 'Get public organization identity (public, unauthenticated)',
    description:
      'Read-only feed for the public marketing site (footer, about, contact pages). ' +
      'Returns only name, contact details, address and logo — nothing else.',
  })
  async getPublicInfo(@CurrentTenant() tenant: Tenant) {
    return this.tenantsService.getPublicInfo(tenant.id);
  }
}
