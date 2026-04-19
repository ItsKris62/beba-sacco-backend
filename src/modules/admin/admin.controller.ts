import {
  Controller, Get, Patch, Param, Body,
  Query, HttpCode, HttpStatus, ParseUUIDPipe, Req,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiResponse, ApiQuery, ApiHeader,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { AdminService } from './admin.service';
import { UpdateKycDto } from './dto/update-kyc.dto';
import { ReviewMemberDto } from './dto/review-member.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

@ApiTags('Admin')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ─── DASHBOARD ────────────────────────────────────────────────

  @Get('dashboard/stats')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({
    summary: 'Admin dashboard stats',
    description: 'Returns total members, active loans, pending KYC count, pending approvals, M-Pesa volume, and default rate.',
  })
  @ApiResponse({ status: 200, description: 'Aggregated metrics' })
  getDashboardStats(@CurrentTenant() tenant: Tenant) {
    return this.adminService.getDashboardStats(tenant.id);
  }

  // ─── MEMBERS ─────────────────────────────────────────────────

  @Get('members')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.TELLER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'Paginated, searchable member list with role and status filters' })
  @ApiQuery({ name: 'search', required: false, description: 'Search by name, email, member number, or national ID' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'inactive'] })
  @ApiQuery({ name: 'role', required: false, enum: UserRole })
  getMembers(
    @CurrentTenant() tenant: Tenant,
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: 'active' | 'inactive',
    @Query('role') role?: UserRole,
  ) {
    return this.adminService.getMembers(tenant.id, { search, page, limit, status, role });
  }

  // ─── PENDING KYC QUEUE ───────────────────────────────────────

  @Get('members/pending')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @ApiOperation({
    summary: 'List members pending KYC review (oldest first)',
    description: 'Returns members with kycStatus = PENDING_REVIEW in FIFO order.',
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated pending members' })
  getPendingMembers(
    @CurrentTenant() tenant: Tenant,
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getPendingMembers(tenant.id, { search, page, limit });
  }

  // ─── KYC REVIEW (APPROVE / REJECT) ───────────────────────────

  @Patch('members/:id/review')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve or reject a member KYC submission',
    description:
      'APPROVE: atomically sets kycStatus = APPROVED and creates FOSA + BOSA accounts. ' +
      'REJECT: sets kycStatus = REJECTED and stores the rejection reason. ' +
      'Both actions send an email notification and audit log.',
  })
  @ApiResponse({
    status: 200,
    description: 'Review recorded',
    schema: { example: { success: true, action: 'APPROVE' } },
  })
  @ApiResponse({ status: 400, description: 'Rejection reason missing' })
  @ApiResponse({ status: 404, description: 'Pending member not found or already reviewed' })
  reviewMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewMemberDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.adminService.reviewMember(id, dto, tenant.id, actor, req.ip);
  }

  // ─── KYC UPDATE ──────────────────────────────────────────────

  @Patch('members/:id/kyc')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update member KYC information',
    description: 'Updates national ID, KRA PIN, phone, address, employer, and date of birth. Audit logged.',
  })
  @ApiResponse({ status: 200, description: 'KYC updated' })
  @ApiResponse({ status: 404, description: 'Member not found' })
  updateKyc(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateKycDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.adminService.updateKyc(id, dto, tenant.id, actor.id, req.ip);
  }
}
