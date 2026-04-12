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
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
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
 * Login and Register are @Public() so they bypass JwtAuthGuard.
 * Logout requires a valid access token.
 *
 * Rate limits:
 *  - POST /auth/login  → 5 attempts / 60 s / IP (brute-force protection)
 *  - POST /auth/register → global (100/min)
 *  - POST /auth/refresh  → @SkipThrottle (high-frequency token rotation is expected)
 *  - POST /auth/logout   → @SkipThrottle
 *
 * TODO: Phase 2 – CAPTCHA on register
 * TODO: Phase 2 – Password reset flow (forgot-password / reset-password)
 * TODO: Phase 3 – Email verification flow
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
  @Throttle({ global: { limit: 5, ttl: 60_000 } }) // 5 attempts per minute per IP (overrides global 100)
  @ApiOperation({
    summary: 'Login with email or phone + password',
    description:
      'Returns access token (15 min) and refresh token (7 days). ' +
      'Store refresh token securely (HttpOnly cookie recommended in production).',
  })
  @ApiResponse({ status: 200, type: LoginResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 429, description: 'Too many login attempts' })
  async login(@Body() loginDto: LoginDto, @Req() req: TenantRequest): Promise<LoginResponseDto> {
    return this.authService.login(loginDto, req.tenant.id, req.ip);
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
  ): Promise<LoginResponseDto> {
    return this.authService.register(registerDto, req.tenant.id, req.ip);
  }

  // ─────────────────────────── REFRESH ───────────────────────────

  @Public()
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
  ): Promise<RefreshTokenResponseDto> {
    return this.authService.refreshToken(refreshDto, req.tenant.id, req.ip);
  }

  // ─────────────────────────── LOGOUT ───────────────────────────

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @SkipThrottle()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Logout – invalidate current session',
    description:
      'Clears the stored refresh token hash. ' +
      'The access token remains valid until its 15-min TTL. ' +
      'Phase 2 will add Redis jti blocklisting for immediate revocation.',
  })
  @ApiResponse({ status: 204, description: 'Logged out successfully' })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: TenantRequest,
  ): Promise<void> {
    return this.authService.logout(user.id, req.tenant.id, req.ip);
  }

  // ─────────────────────────── CHANGE PASSWORD ───────────────────────────

  @Patch('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change password',
    description:
      'Requires the current password for verification. ' +
      'Clears mustChangePassword flag and invalidates all existing sessions. ' +
      'Users with mustChangePassword=true must call this before accessing other endpoints.',
  })
  @ApiResponse({ status: 204, description: 'Password changed successfully' })
  @ApiResponse({ status: 401, description: 'Current password is incorrect' })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: TenantRequest,
  ): Promise<void> {
    return this.authService.changePassword(user.id, req.tenant.id, dto, req.ip);
  }

  // TODO: Phase 2 – POST /auth/forgot-password
  // TODO: Phase 2 – POST /auth/reset-password
  // TODO: Phase 3 – GET /auth/verify-email/:token
}
