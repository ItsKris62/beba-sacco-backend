import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiBearerAuth,
  ApiSecurity,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiHeader,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
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
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a staff or member account',
    description:
      'Creates a user with a server-generated temporary password, sent via SMS ' +
      '(mustChangePassword = true). The plaintext password is never returned in this ' +
      'response — if SMS delivery fails, retrieve it via GET /users/:id/reveal-temp-password. ' +
      'On first login the user must verify their phone via a 6-digit SMS OTP (enforced by ' +
      'POST /auth/login, unless SMS_OTP_BYPASS_ADMIN_CREATED is enabled) before tokens are ' +
      'issued, then set a permanent password. ' +
      'TENANT_ADMIN can create any tenant-level role. ' +
      'MANAGER can create LOAN_OFFICER, ACCOUNTANT, TELLER, MEMBER, CHAIRMAN, or AUDITOR accounts. ' +
      'SUPER_ADMIN is never assignable via this endpoint. ' +
      'For MEMBER self-registration, use POST /auth/register instead.',
  })
  @ApiResponse({ status: 201, description: 'User created. Temporary password sent via SMS.' })
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
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({
    summary: 'List users in this tenant (paginated)',
    description:
      "SUPER_ADMIN queries their own platform tenant's users by default. " +
      'Pass a different tenant UUID via X-Tenant-ID to inspect that tenant instead. ' +
      'TENANT_ADMIN, MANAGER, and AUDITOR are always scoped to their own tenant.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'role', required: false, enum: UserRole })
  findAll(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
    @Query('role') role?: UserRole,
  ) {
    // SUPER_ADMIN: use their own tenantId (platform tenant) so they always see
    // platform-level staff users regardless of which X-Tenant-ID the frontend sends.
    // Non-SUPER_ADMIN roles are always scoped to the tenant from the header.
    const effectiveTenantId = actor.role === UserRole.SUPER_ADMIN ? actor.tenantId : tenant.id;
    return this.usersService.findAll(effectiveTenantId, { page, limit, search, role });
  }

  // ─── GET ONE ─────────────────────────────────────────────────

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'Get user by ID (includes linked member profile)' })
  @ApiResponse({ status: 404, description: 'User not found' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    // For SUPER_ADMIN looking up a specific user, search across all tenants
    // by passing the actor's own tenantId as a fallback so cross-tenant lookups work.
    const effectiveTenantId = actor.role === UserRole.SUPER_ADMIN ? actor.tenantId : tenant.id;
    return this.usersService.findOne(id, effectiveTenantId);
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

  // ─── UPDATE STATUS (Approval Workflow) ───────────────────────

  @Patch(':id/status')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update user approval status',
    description:
      'Explicit approval state machine. ' +
      'Valid transitions: PENDING → APPROVED | REJECTED; APPROVED → SUSPENDED; SUSPENDED → APPROVED. ' +
      'Only MANAGER, TENANT_ADMIN, and SUPER_ADMIN can approve/reject/suspend.',
  })
  @ApiResponse({ status: 200, description: 'Status updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid status transition' })
  @ApiResponse({ status: 403, description: 'Insufficient role to change status' })
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.usersService.updateStatus(id, dto, tenant.id, actor, req.ip);
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

  @Patch(':id/generate-temporary-password')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate a new temporary password',
    description:
      'Generates a new server-side temporary password, stores its Argon2id hash plus an ' +
      'AES-256-GCM encrypted copy (for admin recovery), sets mustChangePassword = true, ' +
      'invalidates existing sessions, and enqueues an SMS to the user with the new password. ' +
      'The plaintext is never returned in this response — retrieve it via ' +
      'GET /users/:id/reveal-temp-password if the SMS fails to queue. Use this when the ' +
      'original temporary password was lost before first login.',
  })
  @ApiResponse({
    status: 200,
    description: 'Temporary password generated',
    schema: {
      example: {
        success: true,
        smsEnqueued: true,
        user: {
          id: '550e8400-e29b-41d4-a716-446655440000',
          email: 'member@example.com',
          firstName: 'Jane',
          lastName: 'Doe',
          role: 'MEMBER',
        },
        message:
          'Temporary password generated and sent via SMS. An admin can also retrieve it via GET /users/:id/reveal-temp-password.',
      },
    },
  })
  @ApiResponse({ status: 403, description: 'Cannot reset own password or higher-role account' })
  @ApiResponse({ status: 404, description: 'User not found' })
  generateTemporaryPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.usersService.generateTemporaryPassword(id, tenant.id, actor, req.ip);
  }

  // ─── REVEAL TEMP PASSWORD (ADMIN FALLBACK) ────────────────────

  @Get(':id/reveal-temp-password')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Roles(UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reveal the current temporary password (admin fallback)',
    description:
      'Decrypts and returns the temporary password set by the most recent create or ' +
      'generate-temporary-password call. Only works until the member sets their own ' +
      'password via PATCH /auth/change-password, at which point the encrypted value is ' +
      'cleared and this endpoint returns an error. Rate-limited to 5 per hour per admin ' +
      '(plaintext credential disclosure), on top of the 5/min IP throttle.',
  })
  @ApiResponse({
    status: 200,
    description: 'Temporary password decrypted and returned',
    schema: { example: { temporaryPassword: 'Q8m#2tLk9@Pa' } },
  })
  @ApiResponse({ status: 400, description: 'User has already set their own password' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 429, description: 'Too many reveal requests — try again later' })
  revealTemporaryPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.usersService.revealTemporaryPassword(id, tenant.id, actor, req.ip);
  }

  // ─── REVEAL PIN (ADMIN FALLBACK) ──────────────────────────────

  @Post(':id/reveal-pin')
  @ApiTags('Users - PIN Management')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Roles(UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reveal the first-login PIN for a user (admin fallback)',
    description:
      'Only valid while the user has not yet completed PIN onboarding. ' +
      "Never returns a previously-issued PIN — always revokes it and issues + SMS's a brand " +
      'new one, so no plaintext PIN is ever stored at rest. Recorded in the audit trail. ' +
      'Rate-limited to 5 per hour per admin (SMS costs money), on top of the 5/min IP throttle.',
  })
  @ApiResponse({
    status: 200,
    description: 'New PIN generated and returned once',
    schema: { example: { pin: '482913', expiresAt: '2026-07-05T21:05:00.000Z' } },
  })
  @ApiResponse({ status: 400, description: 'User has already completed PIN onboarding' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 429, description: 'Too many PIN requests — try again later' })
  revealPin(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.usersService.revealPin(id, tenant.id, actor, req.ip);
  }

  // ─── RESEND PIN ───────────────────────────────────────────────

  @Post(':id/resend-pin')
  @ApiTags('Users - PIN Management')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resend the first-login PIN via SMS',
    description:
      'Regenerates and re-sends the PIN (invalidating the previous one). ' +
      'Use when the original SMS was not received or the PIN expired. Does not reveal the PIN. ' +
      'Rate-limited to 5 per hour per admin (SMS costs money), on top of the 5/min IP throttle.',
  })
  @ApiResponse({ status: 200, description: 'New PIN sent' })
  @ApiResponse({ status: 400, description: 'User has already completed PIN onboarding' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 429, description: 'Too many PIN requests — try again later' })
  resendPin(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.usersService.resendPin(id, tenant.id, actor, req.ip);
  }

  @Post(':id/disable-2fa')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Disable 2FA for a specific user',
    description: 'Admin override to disable 2FA for a user who lost their device and backup codes.',
  })
  @ApiResponse({ status: 200, description: '2FA disabled successfully' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'User not found' })
  disable2fa(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.usersService.disableUser2fa(id, tenant.id, actor, req.ip);
  }
}
