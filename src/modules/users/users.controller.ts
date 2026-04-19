import {
  Controller, Get, Post, Patch, Param, Body,
  Query, HttpCode, HttpStatus, ParseUUIDPipe, Req,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiResponse, ApiQuery, ApiHeader,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

@ApiTags('Users')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ─── CREATE STAFF ACCOUNT ────────────────────────────────────

  @Post()
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a staff or member account',
    description:
      'Creates a user with a temporary password (mustChangePassword = true). ' +
      'TENANT_ADMIN can create any tenant-level role. ' +
      'MANAGER can only create TELLER, AUDITOR, or MEMBER accounts. ' +
      'SUPER_ADMIN is never assignable via this endpoint. ' +
      'For MEMBER self-registration, use POST /auth/register instead.',
  })
  @ApiResponse({ status: 201, description: 'User created successfully' })
  @ApiResponse({ status: 403, description: 'Insufficient role to create this account type' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  create(
    @Body() dto: CreateUserDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.usersService.create(dto, tenant.id, actor, req.ip);
  }

  // ─── LIST ────────────────────────────────────────────────────

  @Get()
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'List users in this tenant (paginated)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'role', required: false, enum: UserRole })
  findAll(
    @CurrentTenant() tenant: Tenant,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
    @Query('role') role?: UserRole,
  ) {
    return this.usersService.findAll(tenant.id, { page, limit, search, role });
  }

  // ─── GET ONE ─────────────────────────────────────────────────

  @Get(':id')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'Get user by ID (includes linked member profile)' })
  @ApiResponse({ status: 404, description: 'User not found' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.usersService.findOne(id, tenant.id);
  }

  // ─── UPDATE ──────────────────────────────────────────────────

  @Patch(':id')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @ApiOperation({
    summary: 'Update user profile or role',
    description:
      'MANAGER cannot modify TENANT_ADMIN accounts or assign the TENANT_ADMIN role. ' +
      'SUPER_ADMIN is never assignable.',
  })
  @ApiResponse({ status: 403, description: 'Role hierarchy violation' })
  @ApiResponse({ status: 404, description: 'User not found' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.usersService.update(id, dto, tenant.id, actor, req.ip);
  }

  // ─── DEACTIVATE ──────────────────────────────────────────────

  @Patch(':id/deactivate')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate a user account',
    description:
      'Immediately invalidates all sessions and marks account inactive. ' +
      'MANAGER cannot deactivate TENANT_ADMIN accounts.',
  })
  @ApiResponse({ status: 200, description: 'User deactivated' })
  @ApiResponse({ status: 400, description: 'User already inactive' })
  @ApiResponse({ status: 403, description: 'Cannot deactivate own account or higher-role account' })
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.usersService.deactivate(id, tenant.id, actor, req.ip);
  }

  // ─── FORCE PASSWORD RESET ────────────────────────────────────

  @Patch(':id/force-password-reset')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Force user to change password on next login',
    description:
      'Sets mustChangePassword = true and invalidates all existing sessions. ' +
      'The user will be blocked from all endpoints (except PATCH /auth/change-password) ' +
      'until they set a new password. ' +
      'MANAGER cannot force-reset TENANT_ADMIN or MANAGER passwords.',
  })
  @ApiResponse({
    status: 200,
    description: 'Password reset forced — all sessions invalidated',
    schema: {
      example: {
        success: true,
        message:
          'Password reset forced. All existing sessions have been invalidated. ' +
          'The user must log in and set a new password before accessing any resources.',
      },
    },
  })
  @ApiResponse({ status: 403, description: 'Cannot reset own password or higher-role account' })
  @ApiResponse({ status: 404, description: 'User not found' })
  forcePasswordReset(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.usersService.forcePasswordReset(id, tenant.id, actor, req.ip);
  }
}
