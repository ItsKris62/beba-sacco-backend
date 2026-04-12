import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
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
import type { JwtPayload } from './strategies/jwt.strategy';

/**
 * Authentication Service
 *
 * Implements all auth flows with:
 * - argon2id password hashing (SASRA-compliant)
 * - JWT access (15 min) + refresh (7 d) token rotation
 * - Refresh token stored as argon2 hash in User.refreshToken
 * - Full audit trail on every auth event
 *
 * TODO: Phase 2 – add Redis jti blocklist for sub-15m access token revocation
 * TODO: Phase 2 – add OAuth2 (Google, Microsoft) strategies
 * TODO: Phase 3 – add TOTP/2FA support
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  // ─────────────────────────── LOGIN ───────────────────────────

  /**
   * Authenticate a user by email or phone within the given tenant.
   * Returns access + refresh token pair on success.
   */
  async login(
    loginDto: LoginDto,
    tenantId: string,
    ipAddress?: string,
  ): Promise<LoginResponseDto> {
    if (!loginDto.email && !loginDto.phone) {
      throw new UnauthorizedException('Provide email or phone');
    }

    const whereClause = loginDto.email
      ? { email: loginDto.email.toLowerCase() }
      : { phone: loginDto.phone };

    const user = await this.prisma.user.findFirst({
      where: { ...whereClause, tenantId },
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
   * Role is always MEMBER – admin account creation is handled via POST /users (Phase 2).
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

    if (user.tenantId !== tenantId) {
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
   * TODO: Phase 2 – add jti to Redis blocklist to revoke access tokens immediately.
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

  // ─────────────────────────── HELPERS ───────────────────────────

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
      this.logger.error('Audit log write failed (non-fatal)', err instanceof Error ? err.stack : err);
    }
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
      where: { id: userId, tenantId },
      select: { id: true, passwordHash: true, email: true },
    });

    if (!user) {
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
}
