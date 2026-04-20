import {
  Controller,
  Post,
  Patch,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiSecurity,
  ApiHeader,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, LoginResponseDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto, RefreshTokenResponseDto } from './dto/refresh.dto';
import { Public } from '../../common/decorators/public.decorator';
import { SkipPasswordCheck } from '../../common/decorators/skip-password-check.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import type { AuthenticatedUser } from './strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

/** Typed request shape after TenantInterceptor + JwtStrategy run */
interface TenantRequest extends Request {
  tenant: Tenant;
  user: AuthenticatedUser;
}

/**
 * Authentication Controller
 *
 * All routes require X-Tenant-ID header (validated by TenantInterceptor).
 * Login, Register, ForgotPassword, and ResetPassword are @Public() so they bypass JwtAuthGuard.
 * Logout requires a valid access token.
 *
 * Rate limits:
 *  - POST /auth/login           → 5 attempts / 60 s / IP (brute-force protection)
 *  - POST /auth/forgot-password → 3 attempts / 60 s / IP (prevent email flooding)
 *  - POST /auth/reset-password  → 5 attempts / 60 s / IP
 *  - POST /auth/register        → global (100/min)
 *  - POST /auth/refresh         → @SkipThrottle (high-frequency token rotation is expected)
 *  - POST /auth/logout          → @SkipThrottle
 */
@ApiTags('Authentication')
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier', required: true })
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ─────────────────────────── LOGIN ───────────────────────────

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 5, ttl: 60_000 } }) // 5 attempts per minute per IP
  @ApiOperation({
    summary: 'Login with email or phone + password',
    description:
      'Returns access token (15 min) and refresh token (7 days). ' +
      'Store refresh token securely (HttpOnly cookie recommended in production).',
  })
  @ApiResponse({ status: 200, type: LoginResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 429, description: 'Too many login attempts' })
  async login(
    @Body() loginDto: LoginDto,
    @Req() req: TenantRequest,
  ): Promise<{ success: boolean; data: LoginResponseDto; error: null }> {
    const data = await this.authService.login(loginDto, req.tenant.id, req.ip);
    return { success: true, data, error: null };
  }

  // ─────────────────────────── REGISTER ───────────────────────────

  @Public()
  @Post('register')
  @ApiOperation({
    summary: 'Self-register as a SACCO member',
    description:
      'Creates a MEMBER account. Tenant is derived from X-Tenant-ID header — ' +
      'do NOT pass tenantId in the body. Elevated-role accounts are created via POST /users (admin only).',
  })
  @ApiResponse({ status: 201, type: LoginResponseDto })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async register(
    @Body() registerDto: RegisterDto,
    @Req() req: TenantRequest,
  ): Promise<{ success: boolean; data: LoginResponseDto; error: null }> {
    const data = await this.authService.register(registerDto, req.tenant.id, req.ip);
    return { success: true, data, error: null };
  }

  // ─────────────────────────── REFRESH ───────────────────────────

  @Public()
  @SkipPasswordCheck()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle()
  @ApiOperation({
    summary: 'Rotate access + refresh token pair',
    description:
      'Submit the current refresh token to receive a new pair. ' +
      'The old refresh token is immediately invalidated (rotation). ' +
      'Suspected reuse will invalidate ALL sessions for the user.',
  })
  @ApiResponse({ status: 200, type: RefreshTokenResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(
    @Body() refreshDto: RefreshTokenDto,
    @Req() req: TenantRequest,
  ): Promise<{ success: boolean; data: RefreshTokenResponseDto; error: null }> {
    const data = await this.authService.refreshToken(refreshDto, req.tenant.id, req.ip);
    return { success: true, data, error: null };
  }

  // ─────────────────────────── LOGOUT ───────────────────────────

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle()
  @SkipPasswordCheck()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Logout – invalidate current session',
    description:
      'Clears the stored refresh token hash. ' +
      'The access token remains valid until its 15-min TTL.',
  })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: TenantRequest,
  ): Promise<{ success: boolean; data: null; error: null }> {
    await this.authService.logout(user.id, req.tenant.id, req.ip);
    return { success: true, data: null, error: null };
  }

  // ─────────────────────────── CHANGE PASSWORD ───────────────────────────

  @Patch('change-password')
  @HttpCode(HttpStatus.OK)
  @SkipPasswordCheck()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change password (authenticated)',
    description:
      'Requires the current password for verification. ' +
      'Clears mustChangePassword flag and invalidates all existing sessions. ' +
      'Users with mustChangePassword=true must call this before accessing other endpoints.',
  })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 401, description: 'Current password is incorrect' })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: TenantRequest,
  ): Promise<{ success: boolean; data: null; error: null }> {
    await this.authService.changePassword(user.id, req.tenant.id, dto, req.ip);
    return { success: true, data: null, error: null };
  }

  // ─────────────────────────── FORGOT PASSWORD ───────────────────────────

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 3, ttl: 60_000 } }) // 3 requests per minute per IP
  @ApiOperation({
    summary: 'Request a password reset email',
    description:
      'Sends a password reset link to the provided email address if an account exists. ' +
      'Always returns 200 to prevent user enumeration. ' +
      'The reset link expires in 15 minutes and is single-use.',
  })
  @ApiResponse({
    status: 200,
    description: 'If the email is registered, a reset link has been sent.',
  })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() req: TenantRequest,
  ): Promise<{ success: boolean; message: string }> {
    await this.authService.forgotPassword(dto, req.tenant.id, req.ip);
    return {
      success: true,
      message: 'If that email is registered, a password reset link has been sent.',
    };
  }

  // ─────────────────────────── RESET PASSWORD ───────────────────────────

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 5, ttl: 60_000 } }) // 5 attempts per minute per IP
  @ApiOperation({
    summary: 'Reset password using the token from the reset email',
    description:
      'Verifies the signed JWT reset token, enforces single-use via nonce, ' +
      'sets the new password, and invalidates all existing sessions. ' +
      'The token expires in 15 minutes.',
  })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({ status: 400, description: 'Reset link is invalid or has expired' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() req: TenantRequest,
  ): Promise<{ success: boolean; message: string }> {
    await this.authService.resetPassword(dto, req.tenant.id, req.ip);
    return {
      success: true,
      message: 'Password reset successfully. Please log in with your new password.',
    };
  }
}
