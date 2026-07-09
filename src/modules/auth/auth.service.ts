import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TenantStatus, UserRole, AccountStatus, PinPurpose } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JwtBlocklistService } from './jwt-blocklist.service';
import { tenantAsyncStorage } from '../../common/services/tenant-context.service';
import { SessionService, DeviceInfo } from './session.service';
import { TwoFactorService } from './two-factor.service';
import { LoginDto, LoginResponseDto, LoginUserDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto, RefreshTokenResponseDto } from './dto/refresh.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { PasswordResetMethod, PasswordResetRequestDto } from './dto/password-reset-request.dto';
import { PasswordResetVerifyDto } from './dto/password-reset-verify.dto';
import { VerifyPinDto } from './dto/verify-pin.dto';
import { VerifyLoginOtpDto } from './dto/verify-login-otp.dto';
import { ResendLoginOtpDto } from './dto/resend-login-otp.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ResetPasswordConfirmDto } from './dto/reset-password-confirm.dto';
import type { JwtPayload } from './strategies/jwt.strategy';
import { QUEUE_NAMES, EmailJobPayload } from '../queue/queue.constants';
import { OtpService } from './otp.service';
import { SmsService } from '../sms/sms.service';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { maskPhone } from '../mpesa/utils/mpesa.utils';
import { RedisService } from '../../common/services/redis.service';
import { PasswordPolicyService } from './password-policy.service';
import { PinService } from '../pin/pin.service';
import { normalizePhone } from '../data-import/utils/phone-normalizer';

/** JWT payload shape for password-reset tokens (separate from access tokens) */
interface PasswordResetPayload {
  sub: string; // userId
  email: string;
  purpose: 'password_reset';
  /** Random nonce stored as argon2 hash in DB — single-use enforcement */
  nonce: string;
}

export interface AuthProfileDto {
  id: string;
  email: string;
  phone: string | null;
  role: UserRole;
  tenantId: string;
  firstName: string;
  lastName: string;
  mustChangePassword: boolean;
  member: {
    id: string;
    memberNumber: string;
    kycStatus: string;
  } | null;
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
    private readonly blocklist: JwtBlocklistService,
    private readonly sessionService: SessionService,
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue<EmailJobPayload>,
    private readonly otpService: OtpService,
    private readonly smsService: SmsService,
    private readonly redis: RedisService,
    private readonly passwordPolicy: PasswordPolicyService,
    private readonly twoFactorService: TwoFactorService,
    private readonly pinService: PinService,
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

  private readonly BLOCK_THRESHOLD = 5; // auto-block after N failures
  private readonly BLOCK_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours

  /**
   * Fire-and-forget: increment FailedLoginAttempt counter and auto-create
   * BlockedIP when the threshold is exceeded.  Must never throw.
   */
  private trackFailedAttemptAsync(tenantId: string, username: string, ipAddress?: string): void {
    if (!ipAddress) return;
    const ip = ipAddress;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    tenantAsyncStorage
      .run(undefined, async () => {
        const updated = await this.prisma.failedLoginAttempt.upsert({
          where: { tenantId_ipAddress_username: { tenantId, ipAddress: ip, username } },
          create: { tenantId, username, ipAddress: ip, attempts: 1, expiresAt },
          update: { attempts: { increment: 1 }, lastAttemptAt: new Date(), expiresAt },
          select: { attempts: true },
        });

        if (updated.attempts >= this.BLOCK_THRESHOLD) {
          const blockExpiry = new Date(Date.now() + this.BLOCK_DURATION_MS);
          await this.prisma.blockedIP.upsert({
            where: { tenantId_ipAddress: { tenantId, ipAddress: ip } },
            create: {
              tenantId,
              ipAddress: ip,
              reason: 'Brute Force',
              expiresAt: blockExpiry,
              isActive: true,
            },
            update: { isActive: true, expiresAt: blockExpiry, blockedAt: new Date() },
          });
          this.logger.warn(`IP ${ip} auto-blocked after ${updated.attempts} failed login attempts`);
        }
      })
      .catch((err: unknown) =>
        this.logger.error(`trackFailedAttemptAsync: ${(err as Error).message}`),
      );
  }

  /**
   * Authenticate a user by email or phone within the given tenant.
   * Returns access + refresh token pair on success.
   */
  async login(loginDto: LoginDto, tenantId: string, ipAddress?: string): Promise<LoginResponseDto> {
    await this.assertTenantAcceptsLogin(tenantId);

    const normalizedEmail =
      typeof loginDto.email === 'string' ? loginDto.email.trim().toLowerCase() : undefined;
    // Strip leading '+' so '254...' and '+254...' both resolve to the same stored value
    const normalizedPhone =
      typeof loginDto.phone === 'string' ? loginDto.phone.trim().replace(/^\+/, '') : undefined;
    const identifier = normalizedEmail || normalizedPhone;

    if (!identifier) {
      throw new UnauthorizedException('Provide email or phone');
    }

    // For phone logins, search both `phone` (auth field) and `phoneNumber` (approval field)
    // so members whose number was stored during admin approval can log in.
    const credentialCondition = normalizedEmail
      ? { email: normalizedEmail }
      : { OR: [{ phone: identifier }, { phoneNumber: identifier }] };

    // Find by credentials without tenant scope first so SUPER_ADMIN
    // (who belongs to the platform tenant) can log in from any tenant context.
    // We bypass the tenant middleware here because login must be able to
    // locate SUPER_ADMIN users regardless of which tenant's login page they use.
    const candidate = await tenantAsyncStorage.run(undefined, () =>
      this.prisma.user.findFirst({
        where: {
          AND: [credentialCondition, { OR: [{ tenantId }, { role: UserRole.SUPER_ADMIN }] }],
        },
        select: {
          id: true,
          email: true,
          phone: true,
          phoneNumber: true,
          passwordHash: true,
          role: true,
          accountStatus: true,
          emailVerified: true,
          firstName: true,
          lastName: true,
          tenantId: true,
          mustChangePassword: true,
          pinLoginRequired: true,
          phoneVerified: true,
          lastPasswordChangeAt: true,
          twoFactorEnabled: true,
          totpEnrolledAt: true,
        },
      }),
    );

    const user = candidate ?? null;

    // Generic message to prevent user enumeration
    if (!user) {
      await this.writeAuditSafe({
        tenantId,
        action: 'AUTH.LOGIN.FAILED',
        resource: 'User',
        metadata: { reason: 'user_not_found', identifier },
        ipAddress,
      });
      this.trackFailedAttemptAsync(tenantId, identifier ?? 'unknown', ipAddress);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.accountStatus !== AccountStatus.ACTIVE) {
      await this.writeAuditSafe({
        tenantId,
        userId: user.id,
        action: 'AUTH.LOGIN.FAILED',
        resource: 'User',
        resourceId: user.id,
        metadata: { reason: 'account_deactivated' },
        ipAddress,
      });
      this.trackFailedAttemptAsync(tenantId, user.email ?? 'unknown', ipAddress);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.pinLoginRequired) {
      await this.writeAuditSafe({
        tenantId,
        userId: user.id,
        action: 'AUTH.LOGIN.FAILED',
        resource: 'User',
        resourceId: user.id,
        metadata: { reason: 'pin_login_required' },
        ipAddress,
      });
      throw new UnauthorizedException(
        'This account has not been activated yet. Verify your PIN via POST /auth/verify-pin first.',
      );
    }

    if (!(await this.verifyPassword(user.passwordHash, loginDto.password))) {
      await this.writeAuditSafe({
        tenantId,
        userId: user.id,
        action: 'AUTH.LOGIN.FAILED',
        resource: 'User',
        resourceId: user.id,
        metadata: { reason: 'invalid_password' },
        ipAddress,
      });
      this.trackFailedAttemptAsync(tenantId, user.email ?? 'unknown', ipAddress);
      throw new UnauthorizedException('Invalid credentials');
    }

    // First-login temp-password accounts must verify phone ownership via a 6-digit
    // SMS OTP before tokens are issued. Scoped to mustChangePassword (not just
    // !phoneVerified) so already-onboarded accounts — which also default to
    // phoneVerified=false unless they went through this or the legacy PIN flow —
    // are never affected; this only ever fires for genuinely new accounts.
    if (user.mustChangePassword && !user.phoneVerified) {
      const rawPhone = user.phone ?? user.phoneNumber;
      if (!rawPhone) {
        throw new UnauthorizedException('No phone number on file for verification');
      }
      // Normalize to 254XXXXXXXXX so the client always sees/round-trips one
      // canonical format, regardless of how the number is stored (stored
      // members may still have local 0XXXXXXXXX from admin-created accounts).
      const phone = normalizePhone(rawPhone).normalized ?? rawPhone;
      const otp = await this.otpService.generate(phone);
      await this.smsService.enqueueSms(
        {
          type: 'LOGIN_OTP',
          phone,
          message: `Your Beba SACCO verification code is ${otp}. It expires in 30 minutes. Do not share this with anyone.`,
        },
        `auth.login_otp:${user.id}`,
      );
      await this.writeAuditSafe({
        tenantId,
        userId: user.id,
        action: 'AUTH.LOGIN.PHONE_VERIFICATION_REQUIRED',
        resource: 'User',
        resourceId: user.id,
        metadata: { reason: 'phone_not_verified' },
        ipAddress,
      });
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Phone verification required',
        requiresPhoneVerification: true,
        phone,
      });
    }

    const enforceEmailVerification =
      this.configService.get<string>('app.features.emailVerificationEnforced') === 'true';
    if (enforceEmailVerification && !user.emailVerified) {
      await this.writeAuditSafe({
        tenantId,
        userId: user.id,
        action: 'LOGIN_ATTEMPT_UNVERIFIED_EMAIL',
        resource: 'User',
        resourceId: user.id,
        metadata: {
          reason: 'email_not_verified',
          email: user.email,
          attemptedAt: new Date().toISOString(),
        },
        ipAddress,
      });
      throw new UnauthorizedException(
        'Email not verified. Please check your inbox or request a new verification link.',
      );
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    const require2FA = (tenant?.settings as any)?.security?.require2FA === true;

    // Check password expiry before generating tokens
    const expiryDays = (tenant?.settings as any)?.security?.passwordPolicy?.expiryDays;
    if (typeof expiryDays === 'number' && expiryDays > 0) {
      const passwordAgeMs = Date.now() - user.lastPasswordChangeAt.getTime();
      const passwordAgeDays = passwordAgeMs / (1000 * 60 * 60 * 24);
      if (passwordAgeDays > expiryDays && !user.mustChangePassword) {
        user.mustChangePassword = true;
        try {
          await this.prisma.user.update({
            where: { id: user.id },
            data: { mustChangePassword: true },
          });
          await this.writeAuditSafe({
            tenantId,
            userId: user.id,
            action: 'AUTH.PASSWORD_EXPIRED',
            resource: 'User',
            resourceId: user.id,
            metadata: { ageDays: Math.floor(passwordAgeDays), expiryDays },
            ipAddress,
          });
        } catch (err) {
          this.logger.error(`Failed to update password expiry for user ${user.id}`, err);
        }
      }
    }

    if (user.twoFactorEnabled) {
      if (!loginDto.totpToken && !loginDto.backupCode) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          message: '2FA token required',
          requires2FA: true,
        });
      }
      if (loginDto.backupCode) {
        await this.twoFactorService.verifyBackupCode(
          user.id,
          tenantId,
          loginDto.backupCode,
          ipAddress,
        );
      } else if (loginDto.totpToken) {
        await this.twoFactorService.verifyToken(user.id, loginDto.totpToken, tenantId);
      }
    } else if (require2FA) {
      const setupToken = this.jwtService.sign(
        {
          sub: user.id,
          email: user.email,
          phone: user.phone ?? user.phoneNumber ?? null,
          role: user.role,
          tenantId: user.tenantId,
          scope: '2fa_setup',
        },
        {
          secret: this.configService.getOrThrow<string>('app.jwt.secret'),
          expiresIn: '15m',
        },
      );
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: '2FA setup required',
        setupToken,
      });
    }

    const { accessToken, refreshToken } = this.generateTokens({
      id: user.id,
      email: user.email,
      phone: user.phone ?? user.phoneNumber ?? null,
      role: user.role,
      tenantId: user.tenantId,
    });

    const refreshHash = await argon2.hash(refreshToken);

    // Bypass tenant middleware: SUPER_ADMIN's DB tenantId differs from the
    // request X-Tenant-ID, so the injected WHERE ... AND tenantId=<header>
    // would find 0 rows and throw P2025. Same bypass as the findFirst above.
    await tenantAsyncStorage.run(undefined, () =>
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          refreshToken: refreshHash,
          lastLoginAt: new Date(),
        },
      }),
    );

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
      migrateRefreshToken: true,
      requiresPasswordChange: user.mustChangePassword,
      user: this.toUserDto(user),
    };
  }

  // ─────────────────────────── VERIFY PIN (first login / onboarding) ───────────────────────────

  /**
   * Verify a first-login PIN and issue a full session, exactly like login().
   * mustChangePassword remains true — the existing JwtAuthGuard enforcement forces
   * the client straight to PATCH /auth/change-password, which clears both
   * mustChangePassword and pinLoginRequired once a real password is set.
   */
  async verifyPin(
    dto: VerifyPinDto,
    tenantId: string,
    ipAddress?: string,
  ): Promise<LoginResponseDto> {
    await this.assertTenantAcceptsLogin(tenantId);

    const normalizedPhone = dto.phone.trim().replace(/^\+/, '');

    const candidate = await tenantAsyncStorage.run(undefined, () =>
      this.prisma.user.findFirst({
        where: {
          AND: [
            { OR: [{ phone: normalizedPhone }, { phoneNumber: normalizedPhone }] },
            { OR: [{ tenantId }, { role: UserRole.SUPER_ADMIN }] },
          ],
        },
        select: {
          id: true,
          email: true,
          phone: true,
          phoneNumber: true,
          role: true,
          accountStatus: true,
          firstName: true,
          lastName: true,
          tenantId: true,
          mustChangePassword: true,
        },
      }),
    );

    if (!candidate || candidate.accountStatus !== AccountStatus.ACTIVE) {
      await this.writeAuditSafe({
        tenantId,
        action: 'AUTH.PIN_LOGIN.FAILED',
        resource: 'User',
        metadata: {
          reason: candidate ? 'account_inactive' : 'user_not_found',
          phone: maskPhone(normalizedPhone),
        },
        ipAddress,
      });
      this.trackFailedAttemptAsync(tenantId, normalizedPhone, ipAddress);
      throw new UnauthorizedException('Invalid phone number or PIN');
    }

    const valid = await this.pinService.validatePin(
      candidate.id,
      candidate.tenantId,
      PinPurpose.FIRST_LOGIN,
      dto.pin,
    );

    if (!valid) {
      await this.writeAuditSafe({
        tenantId,
        userId: candidate.id,
        action: 'AUTH.PIN_LOGIN.FAILED',
        resource: 'User',
        resourceId: candidate.id,
        metadata: { reason: 'invalid_or_expired_pin' },
        ipAddress,
      });
      this.trackFailedAttemptAsync(tenantId, normalizedPhone, ipAddress);
      throw new UnauthorizedException('Invalid or expired PIN');
    }

    const { accessToken, refreshToken } = this.generateTokens({
      id: candidate.id,
      email: candidate.email,
      phone: candidate.phone ?? candidate.phoneNumber ?? null,
      role: candidate.role,
      tenantId: candidate.tenantId,
    });

    const refreshHash = await argon2.hash(refreshToken);

    await tenantAsyncStorage.run(undefined, () =>
      this.prisma.user.update({
        where: { id: candidate.id },
        data: { refreshToken: refreshHash, lastLoginAt: new Date() },
      }),
    );

    await this.writeAuditSafe({
      tenantId,
      userId: candidate.id,
      action: 'AUTH.PIN_LOGIN',
      resource: 'User',
      resourceId: candidate.id,
      metadata: { email: candidate.email, role: candidate.role },
      ipAddress,
    });

    return {
      accessToken,
      refreshToken,
      migrateRefreshToken: true,
      requiresPasswordChange: candidate.mustChangePassword,
      user: this.toUserDto(candidate),
    };
  }

  // ─────────────────────────── VERIFY LOGIN OTP (phone verification) ───────────────────────────

  /**
   * Given an already-normalized 254XXXXXXXXX phone, return every raw format a
   * User row might have it stored in (254XXXXXXXXX or local 0XXXXXXXXX), so a
   * Prisma `in` lookup matches regardless of which convention was used when
   * the row was created. Existing data predates the 254-everywhere fix, so
   * this stays needed until stored numbers are backfilled.
   */
  private phoneLookupVariants(canonicalPhone: string): string[] {
    const variants = new Set<string>([canonicalPhone]);
    if (canonicalPhone.startsWith('254') && canonicalPhone.length === 12) {
      variants.add(`0${canonicalPhone.slice(3)}`);
    }
    return Array.from(variants);
  }

  /**
   * Verify the 6-digit SMS OTP required after a first-time temp-password login
   * (see the mustChangePassword + !phoneVerified gate in login()). On success,
   * marks the phone verified and issues a full session, exactly like login().
   */
  async verifyLoginOtp(
    dto: VerifyLoginOtpDto,
    tenantId: string,
    ipAddress?: string,
  ): Promise<LoginResponseDto> {
    await this.assertTenantAcceptsLogin(tenantId);

    // dto.phone arrives as the canonical 254XXXXXXXXX format (echoed back from
    // login()'s response), but stored User rows may still be in local
    // 0XXXXXXXXX format — match against both so the lookup works either way.
    const normalizedPhone = normalizePhone(dto.phone).normalized ?? dto.phone.trim().replace(/^\+/, '');
    const lookupPhones = this.phoneLookupVariants(normalizedPhone);

    const candidate = await tenantAsyncStorage.run(undefined, () =>
      this.prisma.user.findFirst({
        where: {
          AND: [
            { OR: [{ phone: { in: lookupPhones } }, { phoneNumber: { in: lookupPhones } }] },
            { OR: [{ tenantId }, { role: UserRole.SUPER_ADMIN }] },
          ],
        },
        select: {
          id: true,
          email: true,
          phone: true,
          phoneNumber: true,
          role: true,
          accountStatus: true,
          firstName: true,
          lastName: true,
          tenantId: true,
          mustChangePassword: true,
        },
      }),
    );

    if (!candidate || candidate.accountStatus !== AccountStatus.ACTIVE) {
      await this.writeAuditSafe({
        tenantId,
        action: 'AUTH.LOGIN_OTP.FAILED',
        resource: 'User',
        metadata: {
          reason: candidate ? 'account_inactive' : 'user_not_found',
          phone: maskPhone(normalizedPhone),
        },
        ipAddress,
      });
      this.trackFailedAttemptAsync(tenantId, normalizedPhone, ipAddress);
      throw new UnauthorizedException('Invalid phone number or code');
    }

    const valid = await this.otpService.validate(normalizedPhone, dto.otp);

    if (!valid) {
      await this.writeAuditSafe({
        tenantId,
        userId: candidate.id,
        action: 'AUTH.LOGIN_OTP.FAILED',
        resource: 'User',
        resourceId: candidate.id,
        metadata: { reason: 'invalid_or_expired_otp' },
        ipAddress,
      });
      this.trackFailedAttemptAsync(tenantId, normalizedPhone, ipAddress);
      throw new UnauthorizedException('Invalid or expired code');
    }

    const { accessToken, refreshToken } = this.generateTokens({
      id: candidate.id,
      email: candidate.email,
      phone: candidate.phone ?? candidate.phoneNumber ?? null,
      role: candidate.role,
      tenantId: candidate.tenantId,
    });

    const refreshHash = await argon2.hash(refreshToken);

    await tenantAsyncStorage.run(undefined, () =>
      this.prisma.user.update({
        where: { id: candidate.id },
        data: { phoneVerified: true, refreshToken: refreshHash, lastLoginAt: new Date() },
      }),
    );

    await this.writeAuditSafe({
      tenantId,
      userId: candidate.id,
      action: 'AUTH.LOGIN_OTP.VERIFIED',
      resource: 'User',
      resourceId: candidate.id,
      metadata: { email: candidate.email, role: candidate.role },
      ipAddress,
    });

    return {
      accessToken,
      refreshToken,
      migrateRefreshToken: true,
      requiresPasswordChange: candidate.mustChangePassword,
      user: this.toUserDto(candidate),
    };
  }

  /** Regenerate and re-send the login OTP — rate-limited at the controller. */
  async resendLoginOtp(
    dto: ResendLoginOtpDto,
    tenantId: string,
    ipAddress?: string,
  ): Promise<void> {
    const normalizedPhone = normalizePhone(dto.phone).normalized ?? dto.phone.trim().replace(/^\+/, '');
    const lookupPhones = this.phoneLookupVariants(normalizedPhone);

    const candidate = await tenantAsyncStorage.run(undefined, () =>
      this.prisma.user.findFirst({
        where: {
          AND: [
            { OR: [{ phone: { in: lookupPhones } }, { phoneNumber: { in: lookupPhones } }] },
            { OR: [{ tenantId }, { role: UserRole.SUPER_ADMIN }] },
          ],
        },
        select: { id: true },
      }),
    );

    // Always behave the same whether or not the phone is registered, to avoid
    // leaking account existence — mirrors requestPasswordResetSms's approach.
    if (!candidate) return;

    const otp = await this.otpService.generate(normalizedPhone);
    await this.smsService.enqueueSms(
      {
        type: 'LOGIN_OTP',
        phone: normalizedPhone,
        message: `Your Beba SACCO verification code is ${otp}. It expires in 30 minutes. Do not share this with anyone.`,
      },
      `auth.resend_login_otp:${candidate.id}`,
    );

    await this.writeAuditSafe({
      tenantId,
      userId: candidate.id,
      action: 'AUTH.LOGIN_OTP.RESENT',
      resource: 'User',
      resourceId: candidate.id,
      ipAddress,
    });
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

    const existing = await this.prisma.user.findFirst({
      where: { email: normalizedEmail },
      select: { id: true },
    });

    if (existing) {
      // Don't reveal whether the collision is in this tenant or another
      throw new ConflictException('An account with this email already exists');
    }

    await this.passwordPolicy.validatePassword(tenantId, registerDto.password);

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
        accountStatus: AccountStatus.ACTIVE,
        mustChangePassword: false,
        lastPasswordChangeAt: new Date(),
      },
      select: {
        id: true,
        email: true,
        phone: true,
        phoneNumber: true,
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
      phone: user.phone ?? user.phoneNumber ?? null,
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
      migrateRefreshToken: true,
      requiresPasswordChange: user.mustChangePassword,
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
    deviceInfo?: DeviceInfo,
    ipAddress?: string,
  ): Promise<RefreshTokenResponseDto> {
    const incomingToken = refreshDto.refreshToken;
    if (!incomingToken) {
      throw new UnauthorizedException('Refresh token required');
    }

    let payload: JwtPayload;

    try {
      payload = this.jwtService.verify<JwtPayload>(incomingToken, {
        secret: this.configService.getOrThrow<string>('app.jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Bypass tenant middleware: SUPER_ADMIN refresh tokens must be accepted
    // regardless of which tenant's X-Tenant-ID header is in the request.
    const user = await tenantAsyncStorage.run(undefined, () =>
      this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          email: true,
          phone: true,
          phoneNumber: true,
          role: true,
          tenantId: true,
          accountStatus: true,
          refreshToken: true,
          lastPasswordChangeAt: true,
        },
      }),
    );

    if (!user || user.accountStatus !== AccountStatus.ACTIVE || !user.refreshToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Evaluate password expiry
    await this.passwordPolicy.validatePasswordAge(user.tenantId, user.lastPasswordChangeAt);

    if (user.role !== UserRole.SUPER_ADMIN && user.tenantId !== tenantId) {
      throw new UnauthorizedException('Token/tenant mismatch');
    }

    const isValid = await argon2.verify(user.refreshToken, incomingToken);
    if (!isValid) {
      // Token reuse detected: revoke ALL active sessions and clear the stored hash.
      // An attacker who obtained an old refresh token must not retain any foothold.
      await tenantAsyncStorage.run(undefined, async () => {
        await this.prisma.refreshSession.updateMany({
          where: { userId: user.id, isRevoked: false },
          data: { isRevoked: true },
        });
        await this.prisma.user.update({
          where: { id: user.id },
          data: { refreshToken: null },
        });
      });
      await this.writeAuditSafe({
        tenantId,
        userId: user.id,
        action: 'AUTH.TOKEN.REUSE_DETECTED',
        resource: 'User',
        resourceId: user.id,
        metadata: { severity: 'HIGH', sessionsRevoked: true },
        ipAddress,
      });
      throw new UnauthorizedException('Invalid refresh token');
    }

    // V-03: If a RefreshSession record exists for this user, validate the device
    // fingerprint and rotate the session. Sessions are created via SessionService
    // (SessionController or future login flow). If none exists yet, skip silently
    // so existing users without sessions aren't locked out during the rollout.
    if (deviceInfo) {
      const activeSession = await this.prisma.refreshSession.findFirst({
        where: { userId: user.id, isRevoked: false, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
      if (activeSession) {
        // rotateSession validates deviceId, marks old session revoked, creates new one.
        // Throws ForbiddenException on device mismatch (propagates as 403 to client).
        await this.sessionService.rotateSession(
          activeSession.id,
          user.id,
          deviceInfo,
          user.tenantId,
          ipAddress,
        );
      }
    }

    const { accessToken, refreshToken } = this.generateTokens({
      id: user.id,
      email: user.email,
      phone: user.phone ?? user.phoneNumber ?? null,
      role: user.role,
      tenantId: user.tenantId,
    });

    const newHash = await argon2.hash(refreshToken);

    await tenantAsyncStorage.run(undefined, () =>
      this.prisma.user.update({
        where: { id: user.id },
        data: { refreshToken: newHash },
      }),
    );

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
   * Also blocklists the current access token so it dies immediately (not after 15 min).
   */
  async logout(
    userId: string,
    tenantId: string,
    accessTokenJti?: string,
    ipAddress?: string,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshToken: null },
    });

    // Phase 2: immediate revocation of access token
    if (accessTokenJti) {
      await this.blocklist.add(accessTokenJti);
    }

    await this.writeAuditSafe({
      tenantId,
      userId,
      action: 'AUTH.LOGOUT',
      resource: 'User',
      resourceId: userId,
      metadata: { accessTokenRevoked: !!accessTokenJti },
      ipAddress,
    });
  }

  async getProfile(userId: string, tenantId: string): Promise<AuthProfileDto> {
    return this.prisma.user.findFirstOrThrow({
      where: { id: userId, tenantId },
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        tenantId: true,
        firstName: true,
        lastName: true,
        mustChangePassword: true,
        member: {
          select: {
            id: true,
            memberNumber: true,
            kycStatus: true,
          },
        },
      },
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
    this.assertLegacyAuthEndpointsEnabled();
    const normalizedEmail = dto.email.toLowerCase();

    const user = await this.prisma.user.findFirst({
      where: { email: normalizedEmail },
      select: {
        id: true,
        email: true,
        firstName: true,
        role: true,
        tenantId: true,
        accountStatus: true,
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
    if (!user || user.accountStatus !== AccountStatus.ACTIVE) {
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
    const appUrl = this.configService.get<string>('app.appUrl') ?? 'http://localhost:3000';
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
  async resetPassword(dto: ResetPasswordDto, tenantId: string, ipAddress?: string): Promise<void> {
    this.assertLegacyAuthEndpointsEnabled();
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
        accountStatus: true,
        passwordResetToken: true,
        passwordResetExpiry: true,
      },
    });

    if (!user || user.accountStatus !== AccountStatus.ACTIVE) {
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

    await this.passwordPolicy.validatePassword(tenantId, dto.newPassword);

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
        lastPasswordChangeAt: new Date(),
        refreshToken: null, // Invalidate all existing sessions
        passwordResetToken: null, // Single-use: clear nonce
        passwordResetExpiry: null,
      },
    });

    // Phase 2: blocklist the current access token (if provided) for immediate revocation
    if (dto.accessTokenJti) {
      await this.blocklist.add(dto.accessTokenJti);
    }

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

  // ─────────────────────────── SMS PASSWORD RESET ───────────────────────────

  /**
   * Initiate unified email/SMS password reset.
   *
   * Security design:
   * - Always returns success to prevent user enumeration.
   * - Resolves active users by normalized email or full E.164 phone identifier.
   * - Stores a 6-digit OTP in Redis keyed by the identifier (30 min TTL, max 3 attempts).
   * - Enqueues delivery through the selected channel only when a matching active account exists.
   */
  async requestPasswordResetSms(
    dto: PasswordResetRequestDto,
    tenantId: string,
    ipAddress?: string,
  ): Promise<void> {
    this.assertLegacyAuthEndpointsEnabled();
    const identifier = this.normalizePasswordResetIdentifier(dto.method, dto.identifier);
    await this.assertPasswordResetRequestAllowed(identifier, ipAddress);

    const user = await this.findUserByPasswordResetIdentifier(dto.method, identifier, tenantId);
    const otpKey = user ? this.resolveOtpKey(dto.method, identifier, user) : null;

    await this.writeAuditSafe({
      tenantId,
      userId: user?.id,
      action:
        dto.method === PasswordResetMethod.SMS
          ? AUDIT_ACTIONS.AUTH.PASSWORD_RESET_SMS_REQUESTED
          : 'AUTH.PASSWORD_RESET_EMAIL_OTP_REQUESTED',
      resource: 'User',
      resourceId: user?.id,
      metadata: {
        method: dto.method,
        found: !!user,
        identifierHash: this.hashIdentifier(identifier),
        contact: this.maskPasswordResetIdentifier(dto.method, identifier),
      },
      ipAddress,
    });

    if (!user || !otpKey) {
      return;
    }

    const otp = await this.otpService.generate(otpKey);

    if (dto.method === PasswordResetMethod.SMS) {
      const message =
        `Your Beba SACCO password reset code is ${otp}. ` +
        'Valid for 30 minutes. Do not share this code with anyone.';

      await this.smsService.enqueueSms(
        {
          type: 'PASSWORD_RESET_OTP',
          phone: otpKey,
          message,
        },
        `auth.password-reset-sms:${user.id}`,
      );

      this.logger.log(`Password reset SMS queued for ${maskPhone(otpKey)}`);
      return;
    }

    this.enqueueEmail(
      {
        type: 'PASSWORD_RESET_OTP',
        to: user.email,
        firstName: user.firstName,
        otp,
        expiresInMinutes: 30,
      },
      `auth.password-reset-email-otp:${user.id}`,
    );

    this.logger.log(`Password reset email OTP queued for ${user.email}`);
  }

  /**
   * Complete unified email/SMS OTP password reset.
   *
   * Validates OTP, hashes new password with argon2id, updates User.passwordHash,
   * clears OTP from Redis, invalidates sessions, and writes audit event.
   */
  async verifyPasswordResetSms(
    dto: PasswordResetVerifyDto,
    tenantId: string,
    ipAddress?: string,
  ): Promise<void> {
    this.assertLegacyAuthEndpointsEnabled();
    const identifier = this.normalizePasswordResetIdentifier(dto.method, dto.identifier);
    const user = await this.findUserByPasswordResetIdentifier(dto.method, identifier, tenantId);
    const otpKey = user ? this.resolveOtpKey(dto.method, identifier, user) : null;

    if (!user || !otpKey) {
      await this.writeAuditSafe({
        tenantId,
        action:
          dto.method === PasswordResetMethod.SMS
            ? AUDIT_ACTIONS.AUTH.PASSWORD_RESET_SMS_FAILED
            : 'AUTH.PASSWORD_RESET_EMAIL_OTP_FAILED',
        resource: 'User',
        metadata: {
          reason: 'user_not_found',
          method: dto.method,
          identifierHash: this.hashIdentifier(identifier),
        },
        ipAddress,
      });
      throw new BadRequestException('Invalid or expired OTP');
    }

    try {
      const otpValid = await this.otpService.validate(otpKey, dto.otp);
      if (!otpValid) {
        throw new BadRequestException('Invalid or expired OTP');
      }
    } catch (err: unknown) {
      await this.writeAuditSafe({
        tenantId,
        userId: user.id,
        action:
          dto.method === PasswordResetMethod.SMS
            ? AUDIT_ACTIONS.AUTH.PASSWORD_RESET_SMS_FAILED
            : 'AUTH.PASSWORD_RESET_EMAIL_OTP_FAILED',
        resource: 'User',
        resourceId: user.id,
        metadata: {
          reason: 'invalid_otp',
          method: dto.method,
          contact: this.maskPasswordResetIdentifier(dto.method, identifier),
        },
        ipAddress,
      });
      throw err;
    }

    await this.passwordPolicy.validatePassword(tenantId, dto.newPassword);

    const newPasswordHash = await argon2.hash(dto.newPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newPasswordHash,
        mustChangePassword: false,
        lastPasswordChangeAt: new Date(),
        refreshToken: null,
        passwordResetToken: null,
        passwordResetExpiry: null,
      },
    });

    await this.otpService.delete(otpKey);

    await this.writeAuditSafe({
      tenantId,
      userId: user.id,
      action:
        dto.method === PasswordResetMethod.SMS
          ? AUDIT_ACTIONS.AUTH.PASSWORD_RESET_SMS_COMPLETED
          : 'AUTH.PASSWORD_RESET_EMAIL_OTP_COMPLETED',
      resource: 'User',
      resourceId: user.id,
      metadata: {
        method: dto.method,
        contact: this.maskPasswordResetIdentifier(dto.method, identifier),
        email: user.email,
      },
      ipAddress,
    });

    this.logger.log(`Password reset successful for ${user.email} via ${dto.method}`);
  }

  // ─────────────────────────── PUBLIC PIN PASSWORD RESET ───────────────────────────
  //
  // Distinct from the legacy /auth/forgot-password + /auth/reset-password (email-link JWT)
  // and the unified /auth/password-reset/request + /verify (email/SMS OTP via OtpService)
  // flows above. This one runs on the new tenant-scoped, hashed, DB-audited PinService
  // (PinPurpose.PASSWORD_RESET) and is phone-only, matching the PIN-onboarding flow.

  /**
   * Request a password-reset PIN via SMS. Always resolves generically (no user
   * enumeration) — a PIN is only actually issued if a matching ACTIVE account
   * exists in this exact tenant.
   */
  async requestPasswordResetPin(
    dto: RequestPasswordResetDto,
    tenantId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const identifier = this.normalizePasswordResetIdentifier(PasswordResetMethod.SMS, dto.phone);

    const ipHash = this.hashIdentifier(ipAddress ?? 'unknown-ip');
    const phoneHash = this.hashIdentifier(identifier);
    await this.pinService.assertIssuanceRateLimit(`pwd-reset:${ipHash}:${phoneHash}`, 3, 3600);

    const user = await this.findUserByPasswordResetIdentifier(
      PasswordResetMethod.SMS,
      identifier,
      tenantId,
    );

    await this.writeAuditSafe({
      tenantId,
      userId: user?.id,
      action: 'AUTH.PIN_PASSWORD_RESET_REQUESTED',
      resource: 'User',
      resourceId: user?.id,
      metadata: { found: !!user, identifierHash: phoneHash, contact: maskPhone(identifier) },
      ipAddress,
      userAgent,
    });

    if (!user) return;

    await this.pinService.generateAndIssuePin(
      user.id,
      tenantId,
      PinPurpose.PASSWORD_RESET,
      ipAddress,
    );
  }

  /**
   * Verify a password-reset PIN and set a new password. No tokens are issued —
   * the client must call POST /auth/login with the new password afterwards.
   * Also clears pinLoginRequired, covering the "lost initial onboarding PIN" case.
   */
  async confirmPasswordResetPin(
    dto: ResetPasswordConfirmDto,
    tenantId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const identifier = this.normalizePasswordResetIdentifier(PasswordResetMethod.SMS, dto.phone);
    const user = await this.findUserByPasswordResetIdentifier(
      PasswordResetMethod.SMS,
      identifier,
      tenantId,
    );

    if (!user) {
      await this.writeAuditSafe({
        tenantId,
        action: 'AUTH.PIN_PASSWORD_RESET.FAILED',
        resource: 'User',
        metadata: { reason: 'user_not_found', identifierHash: this.hashIdentifier(identifier) },
        ipAddress,
        userAgent,
      });
      throw new BadRequestException('Invalid or expired PIN');
    }

    const valid = await this.pinService.validatePin(
      user.id,
      tenantId,
      PinPurpose.PASSWORD_RESET,
      dto.pin,
    );

    if (!valid) {
      await this.writeAuditSafe({
        tenantId,
        userId: user.id,
        action: 'AUTH.PIN_PASSWORD_RESET.FAILED',
        resource: 'User',
        resourceId: user.id,
        metadata: { reason: 'invalid_or_expired_pin' },
        ipAddress,
        userAgent,
      });
      throw new BadRequestException('Invalid or expired PIN');
    }

    await this.passwordPolicy.validatePassword(tenantId, dto.newPassword);

    const newHash = await argon2.hash(dto.newPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newHash,
        mustChangePassword: false,
        pinLoginRequired: false,
        phoneVerified: true,
        lastPasswordChangeAt: new Date(),
        refreshToken: null,
      },
    });

    await this.writeAuditSafe({
      tenantId,
      userId: user.id,
      action: 'AUTH.PIN_PASSWORD_RESET',
      resource: 'User',
      resourceId: user.id,
      metadata: { email: user.email },
      ipAddress,
      userAgent,
    });

    this.logger.log(`PIN password reset successful for ${user.email}`);
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
    const user = await tenantAsyncStorage.run(undefined, () =>
      this.prisma.user.findFirst({
        where: { id: userId },
        select: {
          id: true,
          passwordHash: true,
          email: true,
          role: true,
          tenantId: true,
          pinLoginRequired: true,
        },
      }),
    );

    if (!user || (user.role !== UserRole.SUPER_ADMIN && user.tenantId !== tenantId)) {
      throw new UnauthorizedException('User not found');
    }

    // Accounts still in the PIN-onboarding flow have no real password yet — PIN
    // verification was the auth factor, so there is nothing to check here.
    if (!user.pinLoginRequired) {
      if (!dto.currentPassword) {
        throw new BadRequestException('currentPassword is required');
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
    }

    await this.passwordPolicy.validatePassword(tenantId, dto.newPassword);

    const newHash = await argon2.hash(dto.newPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    await tenantAsyncStorage.run(undefined, () =>
      this.prisma.user.update({
        where: { id: userId },
        data: {
          passwordHash: newHash,
          mustChangePassword: false,
          lastPasswordChangeAt: new Date(),
          refreshToken: null,
          ...(user.pinLoginRequired && { pinLoginRequired: false, phoneVerified: true }),
        },
      }),
    );

    // Phase 2: blocklist the current access token for immediate revocation
    if (dto.accessTokenJti) {
      await this.blocklist.add(dto.accessTokenJti);
    }

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
        accountStatus: true,
        passwordHash: true,
      },
    });

    if (!user || user.accountStatus !== AccountStatus.ACTIVE) return null;

    let valid: boolean;
    try {
      valid = await argon2.verify(user.passwordHash, password);
    } catch {
      valid = false;
    }
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

  private async assertPasswordResetRequestAllowed(
    identifier: string,
    ipAddress?: string,
  ): Promise<void> {
    const ipHash = this.hashIdentifier(ipAddress ?? 'unknown-ip');
    const identifierHash = this.hashIdentifier(identifier);
    const key = `auth:password-reset:req:${ipHash}:${identifierHash}`;
    const count = await this.redis.incr(key, 15 * 60);

    if (count > 3) {
      throw new HttpException('Too many password reset requests', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async findUserByPasswordResetIdentifier(
    method: PasswordResetMethod,
    identifier: string,
    tenantId: string,
  ): Promise<{
    id: string;
    email: string;
    firstName: string;
    phone: string | null;
    phoneNumber: string | null;
  } | null> {
    const phoneWithoutPlus = identifier.replace(/^\+/, '');
    const where =
      method === PasswordResetMethod.EMAIL
        ? { email: identifier }
        : {
            OR: [
              { phone: identifier },
              { phone: phoneWithoutPlus },
              { phoneNumber: identifier },
              { phoneNumber: phoneWithoutPlus },
            ],
          };

    return this.prisma.user.findFirst({
      where: {
        tenantId,
        accountStatus: AccountStatus.ACTIVE,
        ...where,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        phone: true,
        phoneNumber: true,
      },
    });
  }

  private resolveOtpKey(
    method: PasswordResetMethod,
    identifier: string,
    user: { email: string; phone: string | null; phoneNumber: string | null },
  ): string | null {
    if (method === PasswordResetMethod.EMAIL) {
      return user.email.toLowerCase();
    }

    if (this.formatPhoneForOtp(user.phoneNumber ?? '') === identifier) {
      return this.formatPhoneForOtp(user.phoneNumber);
    }
    if (this.formatPhoneForOtp(user.phone ?? '') === identifier) {
      return this.formatPhoneForOtp(user.phone);
    }
    return null;
  }

  private normalizePasswordResetIdentifier(
    method: PasswordResetMethod,
    identifier: string,
  ): string {
    const trimmed = identifier.trim();
    return method === PasswordResetMethod.EMAIL
      ? trimmed.toLowerCase()
      : this.formatPhoneForOtp(trimmed);
  }

  private formatPhoneForOtp(phone?: string | null): string {
    const trimmed = phone?.trim() ?? '';
    if (!trimmed) {
      return '';
    }
    return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
  }

  private hashIdentifier(identifier: string): string {
    return createHash('sha256').update(identifier).digest('hex');
  }

  private maskPasswordResetIdentifier(method: PasswordResetMethod, identifier: string): string {
    if (method === PasswordResetMethod.SMS) {
      return maskPhone(identifier);
    }

    const [localPart, domain] = identifier.split('@');
    if (!localPart || !domain) {
      return '***';
    }

    return `${localPart.slice(0, 2)}***@${domain}`;
  }

  /**
   * Legacy email-link and legacy email/SMS-OTP reset flows are superseded by the
   * PIN-based flow (/auth/request-password-reset + /auth/reset-password/confirm).
   * Disabled by default via FEATURE_LEGACY_AUTH_ENDPOINTS_ENABLED — callers get a
   * 410 Gone pointing at the replacement endpoints.
   */
  private assertLegacyAuthEndpointsEnabled(): void {
    const enabled =
      this.configService.get<string>('app.features.legacyAuthEndpointsEnabled') === 'true';
    if (!enabled) {
      throw new HttpException(
        'This endpoint has been retired. Use POST /auth/request-password-reset and ' +
          'POST /auth/reset-password/confirm instead.',
        HttpStatus.GONE,
      );
    }
  }

  private async assertTenantAcceptsLogin(tenantId: string): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, status: true },
    });

    if (!tenant || tenant.status !== TenantStatus.ACTIVE) {
      throw new UnauthorizedException('Invalid credentials');
    }
  }

  private async verifyPassword(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  private generateTokens(user: {
    id: string;
    email: string;
    phone?: string | null;
    role: UserRole;
    tenantId: string;
  }): {
    accessToken: string;
    refreshToken: string;
    jti: string;
  } {
    const jti = uuidv4();
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      phone: user.phone ?? null,
      role: user.role,
      tenantId: user.tenantId,
      jti,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>('app.jwt.secret'),
      expiresIn: this.configService.get<string>('app.jwt.accessExpiration', '15m'),
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>('app.jwt.refreshSecret'),
      expiresIn: this.configService.get<string>('app.jwt.refreshExpiration', '7d'),
    });

    return { accessToken, refreshToken, jti };
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
