import {
  Controller, Get, Post, Param, Body, Query,
  HttpCode, HttpStatus, Req,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiResponse, ApiQuery, ApiHeader, ApiBody,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { ApplicationsService } from './applications.service';
import { OnboardingService } from './onboarding.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ApproveApplicationDto, RejectApplicationDto } from './dto/review-application.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

@ApiTags('Applications (Onboarding)')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('admin/applications')
export class ApplicationsController {
  constructor(
    private readonly applicationsService: ApplicationsService,
    private readonly onboardingService: OnboardingService,
  ) {}

  // ─── SUBMIT ──────────────────────────────────────────────────────────────────

  @Post()
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Submit a member application form',
    description:
      'Staff submits a physical/digital KYC form on behalf of a prospective member. ' +
      'No self-registration. idNumber (7-8 digits) and phoneNumber (Kenyan format) are mandatory.',
  })
  @ApiBody({ type: CreateApplicationDto })
  @ApiResponse({ status: 201, description: 'Application submitted successfully' })
  @ApiResponse({ status: 400, description: 'Validation error (invalid ID/phone format)' })
  @ApiResponse({ status: 409, description: 'Duplicate idNumber or phoneNumber' })
  create(
    @Body() dto: CreateApplicationDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.applicationsService.create(dto, tenant.id, actor.id, req.ip);
  }

  // ─── LIST PENDING ─────────────────────────────────────────────────────────────

  @Get('pending')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER, UserRole.AUDITOR)
  @ApiOperation({
    summary: 'Get pending application review queue',
    description: 'Returns paginated list of SUBMITTED and PENDING_REVIEW applications.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['SUBMITTED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'],
  })
  @ApiResponse({ status: 200, description: 'Paginated application list' })
  findPending(
    @CurrentTenant() tenant: Tenant,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
  ) {
    return this.applicationsService.findPending(tenant.id, { page, limit, status: status as never });
  }

  // ─── GET ONE ─────────────────────────────────────────────────────────────────

  @Get(':id')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'Get a single application by ID' })
  @ApiResponse({ status: 200, description: 'Application details' })
  @ApiResponse({ status: 404, description: 'Application not found' })
  findOne(
    @Param('id') id: string,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.applicationsService.findOne(id, tenant.id);
  }

  // ─── APPROVE ─────────────────────────────────────────────────────────────────

  @Post(':id/approve')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve application and create member account',
    description:
      'Atomically creates: User + Member profile + FOSA account + BOSA account + StageAssignment. ' +
      'Updates application status to APPROVED. Rolls back on any failure.',
  })
  @ApiBody({ type: ApproveApplicationDto })
  @ApiResponse({ status: 200, description: 'Member account created successfully' })
  @ApiResponse({ status: 400, description: 'Application not in approvable state' })
  @ApiResponse({ status: 404, description: 'Application not found' })
  @ApiResponse({ status: 409, description: 'Duplicate user already exists' })
  approve(
    @Param('id') id: string,
    @Body() dto: ApproveApplicationDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.onboardingService.approve(id, tenant.id, actor.id, dto, req.ip);
  }

  // ─── REJECT ───────────────────────────────────────────────────────────────────

  @Post(':id/reject')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a member application',
    description: 'Marks application as REJECTED with a mandatory reason note.',
  })
  @ApiBody({ type: RejectApplicationDto })
  @ApiResponse({ status: 200, description: 'Application rejected' })
  @ApiResponse({ status: 400, description: 'Application not in rejectable state' })
  @ApiResponse({ status: 404, description: 'Application not found' })
  reject(
    @Param('id') id: string,
    @Body() dto: RejectApplicationDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.onboardingService.reject(id, tenant.id, actor.id, dto, req.ip);
  }
}
