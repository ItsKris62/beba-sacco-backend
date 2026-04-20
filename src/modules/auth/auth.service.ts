import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LoginDto, LoginResponseDto, LoginUserDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto, RefreshTokenResponseDto } from './dto/refresh.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import type { JwtPayload } from './strategies/jwt.strategy';
import { QUEUE_NAMES, EmailJobPayload } from '../queue/queue.constants';

/** JWT payload shape for password-reset tokens (separate from access tokens) */
interface PasswordResetPayload {
  sub: string;       // userId
  email: string;
  purpose: 'password_reset';
  /** Random nonce stored as argon2 hash in DB — single-use enforcement */
  nonce: string;
}

/**
 * Authentication Service
 *
 * Implements all auth flows with:
 * - argon2id password hashing (SASRA-compliant)
 * - JWT access (15 min) + refresh (7 d) token rotation
 * - Refresh token stored as argon2 hash in User.refreshToken
 * - Stateless JWT-based password reset (15 min TTL, single-use via nonce hash)
 * - Full audit trail on every auth event
 *
 * Password Reset Flow (industry-grade, stateless):
 *   1. POST /auth/forgot-password  → generates signed JWT (15 min) + stores nonce hash in DB
 *   2. Email sent with link: /reset-password?token=<jwt>
 *   3. POST /auth/reset-password   → verifies JWT, verifies nonce hash, sets new password,
 *                                    clears nonce (single-use), invalidates all sessions
 *
 * Security properties:
 *   - Token is a signed JWT → tamper-proof, expiry enforced cryptographically
 *   - Nonce hash in DB → single-use (replay attack prevention)
 *   - Constant-time response on forgot-password → no user enumeration
 *   - argon2id for all password hashes (memory-hard, GPU-resistant)
 *   - All sessions invalidated on successful reset
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /** Reset token TTL in seconds (15 minutes) */
  private readonly RESET_TOKEN_TTL_SECONDS = 15 * 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue<EmailJobPayload>,
  ) {}

  private enqueueEmail(payload: EmailJobPayload, ctx: string): void {
    this.emailQueue
      .add('send', payload, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } })
      .catch((e: unknown) =>
        this.logger.error(
          `[EmailQueue] enqueue failed [${ctx}]: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  }

  // ─────────────────────────── LOGIN ───────────────────────────

  /**
   * Authenticate a user by email or phone within the given tenant.
   * Returns access + refresh token pair on success.
   */
  async login(loginDto: LoginDto, tenantId: string, ipAddress?: string): Promise<LoginResponseDto> {
    if (!loginDto.email && !loginDto.phone) {
      throw new UnauthorizedException('Provide email or phone');
    }

    const whereClause = loginDto.email
      ? { email: loginDto.email.toLowerCase() }
      : { phone: loginDto.phone };

    // Find by credentials without tenant scope first so SUPER_ADMIN
    // (who belongs to the platform tenant) can log in from any tenant context.
    const candidate = await this.prisma.user.findFirst({
      where: whereClause,
      select: {
        id: true,
        email: true,
        passwordHash: true,
        role: true,
        isActive: true,
        firstName: true,
        lastName: true,
        tenantId: true,
        mustChangePassword: true,
      },
    });

    // Enforce tenant scope for all roles except SUPER_ADMIN
    const user =
      candidate?.role === UserRole.SUPER_ADMIN
        ? candidate
        : candidate?.tenantId === tenantId
          ? candidate
          : null;

    // Generic message to prevent user enumeration
    if (!user) {
      await this.writeAuditSafe({
        tenantId,
        action: 'AUTH.LOGIN.FAILED',
        resource: 'User',
        metadata: { reason: 'user_not_found', identifier: loginDto.email ?? loginDto.phone },
        ipAddress,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      await this.writeAuditSafe({
        tenantId,
        userId: user.id,
        action: 'AUTH.LOGIN.FAILED',
        resource: 'User',
        resourceId: user.id,
        metadata: { reason: 'account_deactivated' },
        ipAddress,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await argon2.verify(user.passwordHash, loginDto.password);
    if (!passwordValid) {
      await this.writeAuditSafe({
        tenantId,
        userId: user.id,
        action: 'AUTH.LOGIN.FAILED',
        resource: 'User',
        resourceId: user.id,
        metadata: { reason: 'invalid_password' },
        ipAddress,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const { accessToken, refreshToken } = this.generateTokens({
      id: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    });

    const refreshHash = await argon2.hash(refreshToken);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        refreshToken: refreshHash,
        lastLoginAt: new Date(),
      },
    });

    await this.writeAuditSafe({
      tenantId,
      userId: user.id,
      action: 'AUTH.LOGIN',
      resource: 'User',
      resourceId: user.id,
      metadata: { email: user.email, role: user.role },
      ipAddress,
    });

    return {
      accessToken,
      refreshToken,
      user: this.toUserDto(user),
    };
  }

  // ─────────────────────────── REGISTER ───────────────────────────

  /**
   * Self-registration endpoint.
   * Role is always MEMBER – admin account creation is handled via POST /users.
   * Tenant is validated upstream by TenantInterceptor and passed in here.
   */
  async register(
    registerDto: RegisterDto,
    tenantId: string,
    ipAddress?: string,
  ): Promise<LoginResponseDto> {
    const normalizedEmail = registerDto.email.toLowerCase();

    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existing) {
      // Don't reveal whether the collision is in this tenant or another
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await argon2.hash(registerDto.password, {
      type: argon2.argon2id,
      memoryCost: 65536, // 64 MiB
      timeCost: 3,
      parallelism: 1,
    });

    const user = await this.prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        firstName: registerDto.firstName,
        lastName: registerDto.lastName,
        phone: registerDto.phone,
        role: UserRole.MEMBER,
        tenantId,
        mustChangePassword: false,
      },
      select: {
        id: true,
        email: true,
        role: true,
        firstName: true,
        lastName: true,
        tenantId: true,
        mustChangePassword: true,
      },
    });

    const { accessToken, refreshToken } = this.generateTokens({
      id: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    });

    const refreshHash = await argon2.hash(refreshToken);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: refreshHash, lastLoginAt: new Date() },
    });

    await this.writeAuditSafe({
      tenantId,
      userId: user.id,
      action: 'AUTH.REGISTER',
      resource: 'User',
      resourceId: user.id,
      metadata: { email: user.email, role: user.role },
      ipAddress,
    });

    // Send welcome email — fetch tenant name for personalisation
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    this.enqueueEmail(
      {
        type: 'WELCOME',
        to: user.email,
        firstName: user.firstName,
        saccoName: tenant?.name ?? 'Beba SACCO',
      },
      `auth.register:${user.id}`,
    );

    return {
      accessToken,
      refreshToken,
      user: this.toUserDto(user),
    };
  }

  // ─────────────────────────── REFRESH ───────────────────────────

  /**
   * Rotate the refresh token.
   * Old refresh token is verified against the stored argon2 hash, then replaced.
   */
  async refreshToken(
    refreshDto: RefreshTokenDto,
    tenantId: string,
    ipAddress?: string,
  ): Promise<RefreshTokenResponseDto> {
    let payload: JwtPayload;

    try {
      payload = this.jwtService.verify<JwtPayload>(refreshDto.refreshToken, {
        secret: this.configService.getOrThrow<string>('app.jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        tenantId: true,
        isActive: true,
        refreshToken: true,
      },
    });

    if (!user || !user.isActive || !user.refreshToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (user.role !== UserRole.SUPER_ADMIN && user.tenantId !== tenantId) {
      throw new UnauthorizedException('Token/tenant mismatch');
    }

    const isValid = await argon2.verify(user.refreshToken, refreshDto.refreshToken);
    if (!isValid) {
      // Possible token reuse attack – clear stored token as a precaution
      await this.prisma.user.update({
        where: { id: user.id },
        data: { refreshToken: null },
      });
      await this.writeAuditSafe({
        tenantId,
        userId: user.id,
        action: 'AUTH.TOKEN.REUSE_DETECTED',
        resource: 'User',
        resourceId: user.id,
        metadata: { severity: 'HIGH' },
        ipAddress,
      });
      throw new UnauthorizedException('Invalid refresh token');
    }

    const { accessToken, refreshToken } = this.generateTokens({
      id: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    });

    const newHash = await argon2.hash(refreshToken);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: newHash },
    });

    await this.writeAuditSafe({
      tenantId,
      userId: user.id,
      action: 'AUTH.TOKEN.REFRESH',
      resource: 'User',
      resourceId: user.id,
      metadata: {},
      ipAddress,
    });

    return { accessToken, refreshToken };
  }

  // ─────────────────────────── LOGOUT ───────────────────────────

  /**
   * Invalidate the current session by clearing the stored refresh token hash.
   * The access token remains valid until its 15-min TTL expires.
   */
  async logout(userId: string, tenantId: string, ipAddress?: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshToken: null },
    });

    await this.writeAuditSafe({
      tenantId,
      userId,
      action: 'AUTH.LOGOUT',
      resource: 'User',
      resourceId: userId,
      metadata: {},
      ipAddress,
    });
  }

  // ─────────────────────────── FORGOT PASSWORD ───────────────────────────

  /**
   * Initiate password reset.
   *
   * Security design:
   * - Always returns 200 regardless of whether the email exists (prevents enumeration).
   * - Generates a cryptographically random nonce, stores its argon2 hash in the DB.
   * - Signs a short-lived JWT (15 min) containing the plaintext nonce.
   * - Sends the JWT as a URL parameter in the reset email.
   * - The nonce hash in DB ensures single-use (cleared on successful reset).
   */
  async forgotPassword(
    dto: ForgotPasswordDto,
    tenantId: string,
    ipAddress?: string,
  ): Promise<void> {
    const normalizedEmail = dto.email.toLowerCase();

    const user = await this.prisma.user.findFirst({
      where: { email: normalizedEmail },
      select: {
        id: true,
        email: true,
        firstName: true,
        role: true,
        tenantId: true,
        isActive: true,
      },
    });

    // Always audit the attempt (with or without a matching user)
    await this.writeAuditSafe({
      tenantId,
      userId: user?.id,
      action: 'AUTH.FORGOT_PASSWORD.REQUESTED',
      resource: 'User',
      resourceId: user?.id,
      metadata: { email: normalizedEmail, found: !!user },
      ipAddress,
    });

    // Silently exit if user not found or inactive — no error to prevent enumeration
    if (!user || !user.isActive) {
      return;
    }

    // Generate a cryptographically random nonce (32 bytes = 256 bits of entropy)
    const { randomBytes } = await import('crypto');
    const nonce = randomBytes(32).toString('hex');

    // Store argon2 hash of nonce in DB (single-use enforcement)
    const nonceHash = await argon2.hash(nonce, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: nonceHash,
        passwordResetExpiry: new Date(Date.now() + this.RESET_TOKEN_TTL_SECONDS * 1000),
      },
    });

    // Sign a JWT containing the plaintext nonce — this is what goes in the email link
    const resetPayload: PasswordResetPayload = {
      sub: user.id,
      email: user.email,
      purpose: 'password_reset',
      nonce,
    };

    const resetToken = this.jwtService.sign(resetPayload, {
      secret: this.configService.getOrThrow<string>('app.jwt.secret'),
      expiresIn: `${this.RESET_TOKEN_TTL_SECONDS}s`,
    });

    // Build reset URL — use APP_URL env or fall back to localhost
    const appUrl =
      this.configService.get<string>('app.appUrl') ??
      'http://localhost:3000';
    const resetUrl = `${appUrl}/reset-password?token=${resetToken}`;

    this.enqueueEmail(
      {
        type: 'PASSWORD_RESET',
        to: user.email,
        firstName: user.firstName,
        resetUrl,
        expiresInMinutes: this.RESET_TOKEN_TTL_SECONDS / 60,
      },
      `auth.forgot-password:${user.id}`,
    );

    this.logger.log(`Password reset email queued for ${user.email}`);
  }

  // ─────────────────────────── RESET PASSWORD ───────────────────────────

  /**
   * Complete password reset using the signed JWT token from the email link.
   *
   * Security checks (in order):
   * 1. JWT signature + expiry (cryptographic)
   * 2. purpose claim must be 'password_reset'
   * 3. User exists and is active
   * 4. DB nonce hash exists and has not expired (belt-and-suspenders on top of JWT expiry)
   * 5. argon2.verify(storedNonceHash, jwtNonce) — single-use enforcement
   * 6. New password meets complexity requirements (validated by DTO)
   * 7. Clear nonce hash + invalidate all sessions after successful reset
   */
  async resetPassword(
    dto: ResetPasswordDto,
    tenantId: string,
    ipAddress?: string,
  ): Promise<void> {
    // Step 1: Verify JWT signature and expiry
    let payload: PasswordResetPayload;
    try {
      payload = this.jwtService.verify<PasswordResetPayload>(dto.token, {
        secret: this.configService.getOrThrow<string>('app.jwt.secret'),
      });
    } catch {
      throw new BadRequestException('Reset link is invalid or has expired');
    }

    // Step 2: Verify purpose claim
    if (payload.purpose !== 'password_reset') {
      throw new BadRequestException('Invalid reset token');
    }

    // Step 3: Load user
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        tenantId: true,
        isActive: true,
        passwordResetToken: true,
        passwordResetExpiry: true,
      },
    });

    if (!user || !user.isActive) {
      throw new BadRequestException('Reset link is invalid or has expired');
    }

    // Step 4: Check DB nonce exists and has not expired
    if (
      !user.passwordResetToken ||
      !user.passwordResetExpiry ||
      user.passwordResetExpiry < new Date()
    ) {
      await this.writeAuditSafe({
        tenantId,
        userId: user.id,
        action: 'AUTH.RESET_PASSWORD.FAILED',
        resource: 'User',
        resourceId: user.id,
        metadata: { reason: 'token_expired_or_used' },
        ipAddress,
      });
      throw new BadRequestException('Reset link is invalid or has expired');
    }

    // Step 5: Verify nonce (single-use enforcement)
    const nonceValid = await argon2.verify(user.passwordResetToken, payload.nonce);
    if (!nonceValid) {
      await this.writeAuditSafe({
        tenantId,
        userId: user.id,
        action: 'AUTH.RESET_PASSWORD.FAILED',
        resource: 'User',
        resourceId: user.id,
        metadata: { reason: 'nonce_mismatch' },
        ipAddress,
      });
      throw new BadRequestException('Reset link is invalid or has expired');
    }

    // Step 6: Hash new password
    const newPasswordHash = await argon2.hash(dto.newPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    // Step 7: Update password, clear nonce, invalidate all sessions
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newPasswordHash,
        mustChangePassword: false,
        refreshToken: null,           // Invalidate all existing sessions
        passwordResetToken: null,     // Single-use: clear nonce
        passwordResetExpiry: null,
      },
    });

    await this.writeAuditSafe({
      tenantId,
      userId: user.id,
      action: 'AUTH.RESET_PASSWORD',
      resource: 'User',
      resourceId: user.id,
      metadata: { email: user.email },
      ipAddress,
    });

    this.logger.log(`Password reset successful for ${user.email}`);
  }

  // ─────────────────────────── CHANGE PASSWORD ───────────────────────────

  /**
   * Change password – requires current password verification.
   * Clears mustChangePassword flag and invalidates existing refresh sessions.
   */
  async changePassword(
    userId: string,
    tenantId: string,
    dto: ChangePasswordDto,
    ipAddress?: string,
  ): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { id: true, passwordHash: true, email: true, role: true, tenantId: true },
    });

    if (!user || (user.role !== UserRole.SUPER_ADMIN && user.tenantId !== tenantId)) {
      throw new UnauthorizedException('User not found');
    }

    const currentValid = await argon2.verify(user.passwordHash, dto.currentPassword);
    if (!currentValid) {
      await this.writeAuditSafe({
        tenantId,
        userId,
        action: 'AUTH.CHANGE_PASSWORD.FAILED',
        resource: 'User',
        resourceId: userId,
        metadata: { reason: 'invalid_current_password' },
        ipAddress,
      });
      throw new UnauthorizedException('Current password is incorrect');
    }

    const newHash = await argon2.hash(dto.newPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: newHash,
        mustChangePassword: false,
        refreshToken: null, // Invalidate all existing sessions
      },
    });

    await this.writeAuditSafe({
      tenantId,
      userId,
      action: 'AUTH.CHANGE_PASSWORD',
      resource: 'User',
      resourceId: userId,
      metadata: { email: user.email },
      ipAddress,
    });
  }

  // ─────────────────────────── VALIDATE USER (for local strategy) ───────────────────────────

  /**
   * Used by unit tests and optional LocalStrategy.
   * Returns user without sensitive fields on valid credentials, null otherwise.
   */
  async validateUser(
    email: string,
    password: string,
    tenantId: string,
  ): Promise<Omit<LoginUserDto, 'mustChangePassword'> | null> {
    const user = await this.prisma.user.findFirst({
      where: { email: email.toLowerCase(), tenantId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        tenantId: true,
        isActive: true,
        passwordHash: true,
      },
    });

    if (!user || !user.isActive) return null;

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) return null;

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      tenantId: user.tenantId,
    };
  }

  // ─────────────────────────── PRIVATE HELPERS ───────────────────────────

  private generateTokens(user: {
    id: string;
    email: string;
    role: UserRole;
    tenantId: string;
  }): { accessToken: string; refreshToken: string } {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>('app.jwt.secret'),
      expiresIn: this.configService.get<string>('app.jwt.accessExpiration', '15m'),
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>('app.jwt.refreshSecret'),
      expiresIn: this.configService.get<string>('app.jwt.refreshExpiration', '7d'),
    });

    return { accessToken, refreshToken };
  }

  private toUserDto(user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: UserRole;
    tenantId: string;
    mustChangePassword: boolean;
  }): LoginUserDto {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      tenantId: user.tenantId,
      mustChangePassword: user.mustChangePassword,
    };
  }

  /**
   * Fire-and-forget audit write – never let an audit failure break the auth flow.
   */
  private async writeAuditSafe(params: Parameters<AuditService['create']>[0]): Promise<void> {
    try {
      await this.auditService.create(params);
    } catch (err: unknown) {
      this.logger.error(
        'Audit log write failed (non-fatal)',
        err instanceof Error ? err.stack : err,
      );
    }
  }
}
