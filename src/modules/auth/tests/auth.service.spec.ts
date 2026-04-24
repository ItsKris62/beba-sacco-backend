import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException, ConflictException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthService } from '../auth.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';

// ─────────────────────────── Mocks ───────────────────────────

const mockPrismaService = {
  user: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

const mockJwtService = {
  sign: jest.fn().mockReturnValue('mock.jwt.token'),
  verify: jest.fn(),
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
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
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

    // TODO: mock argon2.verify → true and assert LoginResponseDto shape
    it.todo('returns access + refresh tokens on valid credentials');

    // TODO: mock argon2.verify → false and assert UnauthorizedException
    it.todo('throws UnauthorizedException on wrong password');

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
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'existing' });

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

    // TODO: mock argon2.verify → true and assert new token pair returned
    it.todo('returns new token pair and stores new refresh hash');

    // TODO: mock argon2.verify → false and assert token reuse audit event fired
    it.todo('detects token reuse and clears stored refresh token');
  });

  // ─── logout ──────────────────────────────────────────────────

  describe('logout', () => {
    it('clears refresh token in DB', async () => {
      mockPrismaService.user.update.mockResolvedValue({});

      await service.logout('user-id', TENANT_ID, '127.0.0.1');

      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-id' },
        data: { refreshToken: null },
      });
    });

    it('writes AUTH.LOGOUT audit log', async () => {
      mockPrismaService.user.update.mockResolvedValue({});

      await service.logout('user-id', TENANT_ID, '127.0.0.1');

      expect(mockAuditService.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'AUTH.LOGOUT', userId: 'user-id' }),
      );
    });
  });
});
