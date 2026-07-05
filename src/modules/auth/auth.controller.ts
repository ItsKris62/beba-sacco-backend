import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiSecurity, ApiHeader } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import type { DeviceInfo } from './session.service';
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
import { PasswordResetRequestDto } from './dto/password-reset-request.dto';
import { PasswordResetVerifyDto } from './dto/password-reset-verify.dto';
import { VerifyPinDto } from './dto/verify-pin.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ResetPasswordConfirmDto } from './dto/reset-password-confirm.dto';
import type { AuthenticatedUser, JwtPayload } from './strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { AuthProfileDto } from './auth.service';

/** Typed request shape after TenantInterceptor + JwtStrategy run */
interface TenantRequest extends Request {
  tenant: Tenant;
  user: AuthenticatedUser;
  cookies: Record<string, string | undefined>;
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
 *  - POST /auth/verify-pin      → 5 attempts / 60 s / IP (brute-force protection)
 *  - POST /auth/forgot-password → 3 attempts / 60 s / IP (prevent email flooding)
 *  - POST /auth/reset-password  → 5 attempts / 60 s / IP
 *  - POST /auth/register        → global (100/min)
 *  - POST /auth/refresh         → @SkipThrottle (high-frequency token rotation is expected)
 *  - POST /auth/logout          → @SkipThrottle
 */
@ApiTags('Authentication')
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier', required: true })
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  /** 7 days in milliseconds — matches JWT_REFRESH_EXPIRATION */
  private readonly REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  constructor(
    private readonly authService: AuthService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  private getRefreshCookiePath(): string {
    const apiPrefix =
      this.configService.get<string>('app.apiPrefix') ??
      process.env.API_PREFIX ??
      'api/v1';
    return `/${apiPrefix.replace(/^\/+|\/+$/g, '')}/auth`;
  }

  /** Set the HttpOnly refresh token cookie */
  private setRefreshCookie(res: Response, token: string): void {
    res.cookie('refresh_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: this.getRefreshCookiePath(),
      maxAge: this.REFRESH_COOKIE_MAX_AGE_MS,
    });
  }

  /** Clear the refresh token cookie on logout */
  private clearRefreshCookie(res: Response): void {
    res.clearCookie('refresh_token', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: this.getRefreshCookiePath(),
    });
    // Clear the previous hard-coded path as a migration cleanup for existing
    // production browsers that logged in before API_PREFIX-aware cookies.
    res.clearCookie('refresh_token', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/api/auth',
    });
  }

  /** Extract JTI from the Authorization header for immediate token revocation */
  private extractJti(req: TenantRequest): string | undefined {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return undefined;
    try {
      const token = authHeader.slice(7);
      const payload = this.jwtService.decode(token) as JwtPayload | null;
      return payload?.jti;
    } catch {
      return undefined;
    }
  }

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
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean; data: LoginResponseDto; error: null }> {
    // Log request details
    this.logger.log('Login attempt', {
      email: loginDto.email,
      ip: req.ip,
      tenantId: req.tenant?.id,
    });
    if (!req.tenant?.id) {
      throw new BadRequestException('Missing X-Tenant-ID header');
    }
    try {
      const data = await this.authService.login(loginDto, req.tenant.id, req.ip);
      this.setRefreshCookie(res, data.refreshToken);
      return { success: true, data: { ...data, migrateRefreshToken: true }, error: null };
    } catch (error) {
      this.logger.error(`Login failed for tenant ${req?.tenant?.id}: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  // ─────────────────────────── VERIFY PIN ───────────────────────────

  @Public()
  @ApiTags('Auth - PIN Flow')
  @Post('verify-pin')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 5, ttl: 60_000 } }) // 5 attempts per minute per IP
  @ApiOperation({
    summary: 'Verify a first-login PIN and log in',
    description:
      'For accounts created via POST /users. Verifies the temporary PIN sent by SMS and, ' +
      'on success, returns access + refresh tokens exactly like POST /auth/login. ' +
      'requiresPasswordChange will be true — the client must immediately call ' +
      'PATCH /auth/change-password to set a permanent password.',
  })
  @ApiResponse({ status: 200, type: LoginResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid phone number or PIN' })
  @ApiResponse({ status: 429, description: 'Too many attempts' })
  async verifyPin(
    @Body() dto: VerifyPinDto,
    @Req() req: TenantRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean; data: LoginResponseDto; error: null }> {
    if (!req.tenant?.id) {
      throw new BadRequestException('Missing X-Tenant-ID header');
    }
    const data = await this.authService.verifyPin(dto, req.tenant.id, req.ip);
    this.setRefreshCookie(res, data.refreshToken);
    return { success: true, data: { ...data, migrateRefreshToken: true }, error: null };
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
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean; data: LoginResponseDto; error: null }> {
    const data = await this.authService.register(registerDto, req.tenant.id, req.ip);
    this.setRefreshCookie(res, data.refreshToken);
    return { success: true, data: { ...data, migrateRefreshToken: true }, error: null };
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
      'Submit the current refresh token (in body or HttpOnly cookie) to receive a new pair. ' +
      'The old refresh token is immediately invalidated (rotation). ' +
      'Suspected reuse will invalidate ALL sessions for the user.',
  })
  @ApiResponse({ status: 200, type: RefreshTokenResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(
    @Body() refreshDto: RefreshTokenDto,
    @Req() req: TenantRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean; data: RefreshTokenResponseDto; error: null }> {
    const token = req.cookies?.refresh_token ?? refreshDto.refreshToken;
    if (!token) throw new UnauthorizedException('Refresh token required');

    const deviceInfo: DeviceInfo = {
      userAgent: req.headers['user-agent'] ?? 'unknown',
      timezone: req.headers['x-timezone'] as string | undefined,
      screenRes: req.headers['x-screen-res'] as string | undefined,
    };
    const data = await this.authService.refreshToken(
      { refreshToken: token },
      req.tenant.id,
      deviceInfo,
      req.ip,
    );
    this.setRefreshCookie(res, data.refreshToken);
    return { success: true, data, error: null };
  }

  // ─────────────────────────── LOGOUT ───────────────────────────

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
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
  @ApiResponse({ status: 204, description: 'Logged out successfully' })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: TenantRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const jti = this.extractJti(req);
    await this.authService.logout(user.id, req.tenant.id, jti, req.ip);
    this.clearRefreshCookie(res);
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get the current authenticated user profile',
    description: 'Returns user profile and member details scoped to the current tenant.',
  })
  @ApiResponse({ status: 200, description: 'Current user profile' })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  async me(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: TenantRequest,
  ): Promise<{ success: boolean; data: AuthProfileDto; error: null }> {
    const data = await this.authService.getProfile(user.id, req.tenant.id);
    return { success: true, data, error: null };
  }

  // ─────────────────────────── SMS PASSWORD RESET ───────────────────────────

  @Public()
  @Post('password-reset/request')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 3, ttl: 900_000 } })
  @ApiOperation({
    summary: 'Request email or SMS OTP for password reset',
    description:
      '**Legacy email-based flow.** For the new web app, use the PIN-based flow endpoints ' +
      '(POST /auth/request-password-reset + POST /auth/reset-password/confirm) instead. ' +
      'This endpoint remains for clients not yet migrated. ' +
      'Accepts method EMAIL or SMS plus a validated email/E.164 phone identifier. ' +
      'If a matching active account exists, a 6-digit OTP is sent through the selected channel. ' +
      'Always returns 200 to prevent user enumeration.',
  })
  @ApiResponse({
    status: 200,
    description: 'If the contact matches an account, an OTP has been sent.',
  })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async requestPasswordResetSms(
    @Body() dto: PasswordResetRequestDto,
    @Req() req: TenantRequest,
  ): Promise<{ success: boolean; message: string }> {
    await this.authService.requestPasswordResetSms(dto, req.tenant.id, req.ip);
    return {
      success: true,
      message: 'If an account exists with this contact, an OTP has been sent.',
    };
  }

  @Public()
  @Post('password-reset/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Verify email/SMS OTP and set a new password',
    description:
      '**Legacy email-based flow.** For the new web app, use the PIN-based flow endpoints ' +
      '(POST /auth/request-password-reset + POST /auth/reset-password/confirm) instead. ' +
      'This endpoint remains for clients not yet migrated. ' +
      'Validates the OTP against Redis, hashes the new password with argon2id, ' +
      'updates the user record, clears the OTP, and invalidates existing sessions.',
  })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({ status: 400, description: 'Invalid OTP, identifier, or password' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async verifyPasswordResetSms(
    @Body() dto: PasswordResetVerifyDto,
    @Req() req: TenantRequest,
  ): Promise<{ success: boolean; message: string }> {
    await this.authService.verifyPasswordResetSms(dto, req.tenant.id, req.ip);
    return {
      success: true,
      message: 'Password reset successfully. Please log in with your new password.',
    };
  }

  // ─────────────────────────── PUBLIC PIN PASSWORD RESET ───────────────────────────
  //
  // Phone-only, PIN-based reset on the new tenant-scoped/audited PinService. Also covers
  // "lost my initial onboarding PIN" since it clears pinLoginRequired on success.
  // Distinct from /auth/password-reset/request|verify above (email/SMS OTP, legacy OtpService)
  // and from /auth/forgot-password + /auth/reset-password (email-link JWT token flow) —
  // those paths were already taken, so this flow lives at its own paths.

  @Public()
  @ApiTags('Auth - PIN Flow')
  @Post('request-password-reset')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 3, ttl: 3_600_000 } }) // 3 requests per hour per IP
  @ApiOperation({
    summary: 'Request a password-reset PIN via SMS',
    description:
      'Accepts a phone number. If a matching ACTIVE account exists in this tenant, a PIN ' +
      '(4-6 digits, 20-minute TTL) is sent via SMS. Always returns 200 to prevent phone ' +
      'number enumeration. Rate-limited per IP (3/hour) and per IP+phone pair (3/hour).',
  })
  @ApiResponse({
    status: 200,
    description: 'If the phone number is registered, a PIN has been sent.',
  })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async requestPasswordReset(
    @Body() dto: RequestPasswordResetDto,
    @Req() req: TenantRequest,
  ): Promise<{ success: boolean; message: string }> {
    await this.authService.requestPasswordResetPin(
      dto,
      req.tenant.id,
      req.ip,
      req.headers['user-agent'],
    );
    return {
      success: true,
      message: 'If the phone number is registered, a PIN has been sent.',
    };
  }

  @Public()
  @ApiTags('Auth - PIN Flow')
  @Post('reset-password/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 5, ttl: 60_000 } }) // 5 attempts per minute per IP
  @ApiOperation({
    summary: 'Verify the password-reset PIN and set a new password',
    description:
      'Validates the PIN, hashes newPassword with argon2id, updates the account, and ' +
      'invalidates existing sessions. No tokens are issued — log in via POST /auth/login ' +
      'afterwards. Also clears pinLoginRequired, covering a lost initial onboarding PIN.',
  })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired PIN, or confirmPassword mismatch' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async confirmPasswordReset(
    @Body() dto: ResetPasswordConfirmDto,
    @Req() req: TenantRequest,
  ): Promise<{ success: boolean; message: string }> {
    await this.authService.confirmPasswordResetPin(
      dto,
      req.tenant.id,
      req.ip,
      req.headers['user-agent'],
    );
    return {
      success: true,
      message: 'Password reset successfully. Please log in with your new password.',
    };
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
      'Requires the current password for verification, UNLESS the account is still in the ' +
      'PIN-onboarding flow (pinLoginRequired = true), in which case there is no existing ' +
      'password to check. Clears mustChangePassword (and pinLoginRequired, if set) and ' +
      'invalidates all existing sessions. ' +
      'Users with mustChangePassword=true must call this before accessing other endpoints.',
  })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 400, description: 'currentPassword required, or confirmPassword mismatch' })
  @ApiResponse({ status: 401, description: 'Current password is incorrect' })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: TenantRequest,
  ): Promise<{ success: boolean; data: null; error: null }> {
    // If frontend didn't send JTI, extract it from the Authorization header
    if (!dto.accessTokenJti) {
      dto.accessTokenJti = this.extractJti(req);
    }
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
      '**Legacy email-based flow.** For the new web app, use the PIN-based flow endpoints ' +
      '(POST /auth/request-password-reset + POST /auth/reset-password/confirm) instead. ' +
      'This endpoint remains for clients not yet migrated. ' +
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
      '**Legacy email-based flow.** For the new web app, use the PIN-based flow endpoints ' +
      '(POST /auth/request-password-reset + POST /auth/reset-password/confirm) instead. ' +
      'This endpoint remains for clients not yet migrated. ' +
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
    // If user is logged in while resetting, extract JTI for immediate revocation
    if (!dto.accessTokenJti) {
      dto.accessTokenJti = this.extractJti(req);
    }
    await this.authService.resetPassword(dto, req.tenant.id, req.ip);
    return {
      success: true,
      message: 'Password reset successfully. Please log in with your new password.',
    };
  }
}
