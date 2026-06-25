import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException, ConflictException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { TenantStatus, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuthService } from '../auth.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { JwtBlocklistService } from '../jwt-blocklist.service';
import { SessionService } from '../session.service';
import { OtpService } from '../otp.service';
import { SmsService } from '../../sms/sms.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import { RedisService } from '../../../common/services/redis.service';

jest.mock('argon2', () => ({
  verify: jest.fn(),
  hash: jest.fn(),
}));

// ─────────────────────────── Mocks ───────────────────────────

const mockPrismaService = {
  user: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  // Required by V-02 bulk session revocation in refreshToken() reuse branch
  refreshSession: {
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    findFirst: jest.fn().mockResolvedValue(null),
  },
  failedLoginAttempt: {
    upsert: jest.fn().mockResolvedValue({ attempts: 1 }),
  },
  blockedIP: {
    upsert: jest.fn().mockResolvedValue({}),
  },
  tenant: {
    findUnique: jest.fn().mockResolvedValue({ id: 'tenant-uuid-1234', status: TenantStatus.ACTIVE, name: 'Test SACCO' }),
  },
};

const mockJwtService = {
  sign: jest.fn().mockReturnValue('mock.jwt.token'),
  verify: jest.fn(),
  decode: jest.fn(),
};

const mockConfigService = {
  get: jest.fn((key: string, defaultVal?: string) => {
    const map: Record<string, string> = {
      'app.jwt.secret': 'test-secret-at-least-32-chars-long!!',
      'app.jwt.refreshSecret': 'test-refresh-secret-at-least-32-chars!',
      'app.jwt.accessExpiration': '15m',
      'app.jwt.refreshExpiration': '7d',
    };
    return map[key] ?? defaultVal;
  }),
  getOrThrow: jest.fn((key: string) => {
    const map: Record<string, string> = {
      'app.jwt.secret': 'test-secret-at-least-32-chars-long!!',
      'app.jwt.refreshSecret': 'test-refresh-secret-at-least-32-chars!',
    };
    if (!map[key]) throw new Error(`Config key not found: ${key}`);
    return map[key];
  }),
};

const mockAuditService = {
  create: jest.fn().mockResolvedValue(undefined),
};

const mockJwtBlocklistService = {
  add: jest.fn().mockResolvedValue(undefined),
  isBlocked: jest.fn().mockResolvedValue(false),
  addMany: jest.fn().mockResolvedValue(undefined),
  cleanup: jest.fn().mockResolvedValue(undefined),
};

const mockSessionService = {
  createSession: jest.fn().mockResolvedValue('mock-session-id'),
  rotateSession: jest.fn().mockResolvedValue('mock-new-session-id'),
  revokeSession: jest.fn().mockResolvedValue(undefined),
  listSessions: jest.fn().mockResolvedValue([]),
  generateDeviceId: jest.fn().mockReturnValue('mock-device-id'),
};

const mockEmailQueue = {
  add: jest.fn().mockResolvedValue(undefined),
};

const mockOtpService = {
  generate: jest.fn().mockResolvedValue('123456'),
  validate: jest.fn().mockResolvedValue(true),
  delete: jest.fn().mockResolvedValue(undefined),
};

const mockSmsService = {
  enqueueSms: jest.fn().mockResolvedValue(undefined),
};

const mockRedisService = {
  incr: jest.fn().mockResolvedValue(1),
};

// ─────────────────────────── Test Suite ───────────────────────────

describe('AuthService', () => {
  let service: AuthService;

  const TENANT_ID = 'tenant-uuid-1234';

  const baseUser = {
    id: 'user-uuid-1234',
    email: 'test@kcboda.co.ke',
    passwordHash: '$argon2id$mock-hash',
    role: UserRole.MEMBER,
    isActive: true,
    firstName: 'John',
    lastName: 'Doe',
    tenantId: TENANT_ID,
    mustChangePassword: false,
    emailVerified: false,
    phone: '254712345678',
    phoneNumber: null,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: JwtBlocklistService, useValue: mockJwtBlocklistService },
        { provide: SessionService, useValue: mockSessionService },
        { provide: getQueueToken(QUEUE_NAMES.EMAIL), useValue: mockEmailQueue },
        { provide: OtpService, useValue: mockOtpService },
        { provide: SmsService, useValue: mockSmsService },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
    mockPrismaService.tenant.findUnique.mockResolvedValue({
      id: TENANT_ID,
      status: TenantStatus.ACTIVE,
      name: 'Test SACCO',
    });
    mockJwtService.sign
      .mockReturnValueOnce('access.jwt.token')
      .mockReturnValueOnce('refresh.jwt.token');
  });

  // ─── validateUser ────────────────────────────────────────────

  describe('validateUser', () => {
    it('returns null when user does not exist', async () => {
      mockPrismaService.user.findFirst.mockResolvedValue(null);

      const result = await service.validateUser('nope@test.com', 'password', TENANT_ID);

      expect(result).toBeNull();
    });

    it('returns null when user is inactive', async () => {
      mockPrismaService.user.findFirst.mockResolvedValue({ ...baseUser, isActive: false });

      const result = await service.validateUser(baseUser.email, 'password', TENANT_ID);

      expect(result).toBeNull();
    });

    // TODO: Phase 1 test – mock argon2.verify to return true and assert non-null return
    it.todo('returns user DTO when credentials are valid');

    // TODO: Phase 1 test – mock argon2.verify to return false and assert null return
    it.todo('returns null when password is wrong');
  });

  // ─── login ───────────────────────────────────────────────────

  describe('login', () => {
    it('throws UnauthorizedException when user is not found', async () => {
      mockPrismaService.user.findFirst.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nobody@test.com', password: 'Pass123!' }, TENANT_ID, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when account is deactivated', async () => {
      mockPrismaService.user.findFirst.mockResolvedValue({ ...baseUser, isActive: false });

      await expect(
        service.login({ email: baseUser.email, password: 'Pass123!' }, TENANT_ID),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('returns access + refresh tokens on valid credentials', async () => {
      mockPrismaService.user.findFirst.mockResolvedValue(baseUser);
      mockPrismaService.user.update.mockResolvedValue({ ...baseUser, refreshToken: 'hashed-refresh' });
      jest.mocked(argon2.verify).mockResolvedValueOnce(true);
      jest.mocked(argon2.hash).mockResolvedValueOnce('hashed-refresh-token');

      const result = await service.login(
        { email: baseUser.email.toUpperCase(), password: 'Pass123!' },
        TENANT_ID,
        '127.0.0.1',
      );

      expect(result).toEqual({
        accessToken: 'access.jwt.token',
        refreshToken: 'refresh.jwt.token',
        migrateRefreshToken: true,
        requiresPasswordChange: false,
        user: {
          id: baseUser.id,
          email: baseUser.email,
          firstName: baseUser.firstName,
          lastName: baseUser.lastName,
          role: baseUser.role,
          tenantId: TENANT_ID,
          mustChangePassword: false,
        },
      });
      expect(mockPrismaService.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({ passwordHash: true, phone: true, phoneNumber: true }),
        }),
      );
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: baseUser.id,
          tenantId: TENANT_ID,
          role: UserRole.MEMBER,
          email: baseUser.email,
          phone: baseUser.phone,
        }),
        expect.objectContaining({ expiresIn: '15m' }),
      );
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: baseUser.id },
        data: expect.objectContaining({ refreshToken: 'hashed-refresh-token' }),
      });
      expect(JSON.stringify(result)).not.toContain('passwordHash');
    });

    it('throws UnauthorizedException on wrong password', async () => {
      mockPrismaService.user.findFirst.mockResolvedValue(baseUser);
      jest.mocked(argon2.verify).mockResolvedValueOnce(false);

      await expect(
        service.login({ email: baseUser.email, password: 'WrongPass123!' }, TENANT_ID),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockPrismaService.user.update).not.toHaveBeenCalled();
      expect(mockAuditService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'AUTH.LOGIN.FAILED',
          metadata: expect.objectContaining({ reason: 'invalid_password' }),
        }),
      );
    });

    it('throws UnauthorizedException when tenant is locked', async () => {
      mockPrismaService.tenant.findUnique.mockResolvedValueOnce({
        id: TENANT_ID,
        status: TenantStatus.SUSPENDED,
      });

      await expect(
        service.login({ email: baseUser.email, password: 'Pass123!' }, TENANT_ID),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockPrismaService.user.findFirst).not.toHaveBeenCalled();
    });

    it('writes a FAILED audit log when user is not found', async () => {
      mockPrismaService.user.findFirst.mockResolvedValue(null);

      await expect(
        service.login({ email: 'ghost@test.com', password: 'Pass123!' }, TENANT_ID, '1.2.3.4'),
      ).rejects.toThrow();

      expect(mockAuditService.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'AUTH.LOGIN.FAILED', tenantId: TENANT_ID }),
      );
    });
  });

  // ─── register ────────────────────────────────────────────────

  describe('register', () => {
    it('throws ConflictException when email is already taken', async () => {
      mockPrismaService.user.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(
        service.register(
          { email: 'existing@test.com', password: 'Pass123!', firstName: 'A', lastName: 'B' },
          TENANT_ID,
        ),
      ).rejects.toThrow(ConflictException);
    });

    // TODO: assert role is always MEMBER regardless of what is passed
    it.todo('always creates user with MEMBER role');

    // TODO: assert returned tokens are valid JWT shapes
    it.todo('returns token pair and user DTO on success');
  });

  // ─── refreshToken ────────────────────────────────────────────

  describe('refreshToken', () => {
    it('throws UnauthorizedException when refresh token JWT is invalid', async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('jwt malformed');
      });

      await expect(
        service.refreshToken({ refreshToken: 'bad.token.here' }, TENANT_ID),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when user not found after valid JWT', async () => {
      mockJwtService.verify.mockReturnValue({ sub: 'user-id', email: 'test@test.com' });
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      await expect(
        service.refreshToken({ refreshToken: 'valid.jwt.here' }, TENANT_ID),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('revokes all RefreshSessions when token reuse is detected', async () => {
      mockJwtService.verify.mockReturnValue({ sub: baseUser.id, email: baseUser.email, tenantId: TENANT_ID });
      mockPrismaService.user.findUnique.mockResolvedValue({
        ...baseUser,
        // Non-null refreshToken so the flow reaches argon2.verify
        refreshToken: '$argon2id$stored-hash',
      });
      // argon2.verify returns false → reuse detected
      jest.mocked(argon2.verify).mockResolvedValueOnce(false);

      await expect(
        service.refreshToken({ refreshToken: 'reused.token' }, TENANT_ID),
      ).rejects.toThrow(UnauthorizedException);

      // V-02: all RefreshSession records must be revoked
      expect(mockPrismaService.refreshSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: baseUser.id, isRevoked: false }),
          data: { isRevoked: true },
        }),
      );

      // Audit log must capture the reuse event
      expect(mockAuditService.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'AUTH.TOKEN.REUSE_DETECTED' }),
      );
    });

    // TODO: mock argon2.verify → true and assert new token pair returned
    it.todo('returns new token pair and stores new refresh hash');
  });

  // ─── logout ──────────────────────────────────────────────────

  describe('logout', () => {
    it('clears refresh token in DB', async () => {
      mockPrismaService.user.update.mockResolvedValue({});

      // Pass undefined for accessTokenJti (no blocklist interaction needed for this test)
      await service.logout('user-id', TENANT_ID, undefined, '127.0.0.1');

      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-id' },
        data: { refreshToken: null },
      });
    });

    it('blocklists the access token JTI when provided', async () => {
      mockPrismaService.user.update.mockResolvedValue({});

      await service.logout('user-id', TENANT_ID, 'mock-jti-uuid', '127.0.0.1');

      expect(mockJwtBlocklistService.add).toHaveBeenCalledWith('mock-jti-uuid');
    });

    it('writes AUTH.LOGOUT audit log', async () => {
      mockPrismaService.user.update.mockResolvedValue({});

      await service.logout('user-id', TENANT_ID, undefined, '127.0.0.1');

      expect(mockAuditService.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'AUTH.LOGOUT', userId: 'user-id' }),
      );
    });
  });
});

