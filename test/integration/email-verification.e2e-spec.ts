import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { getQueueToken } from '@nestjs/bullmq';
import { UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuthService } from '../../src/modules/auth/auth.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { JwtBlocklistService } from '../../src/modules/auth/jwt-blocklist.service';
import { SessionService } from '../../src/modules/auth/session.service';
import { RedisService } from '../../src/common/services/redis.service';
import { QUEUE_NAMES } from '../../src/modules/queue/queue.constants';

describe('Email Verification Enforcement', () => {
  const JWT_SECRET = 'test-access-secret-at-least-64-characters-long-for-e2e-suite';
  const JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-64-characters-long-for-e2e-suite';

  const buildService = async (emailVerified: boolean, flag = 'true') => {
    const passwordHash = await argon2.hash('TestPassword123!');
    const auditCreate = jest.fn(async () => undefined);
    const userUpdate = jest.fn(async () => undefined);

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: '15m' },
        }),
      ],
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findFirst: jest.fn(async () => ({
                id: 'user-1',
                email: 'member@test.co.ke',
                passwordHash,
                role: UserRole.MEMBER,
                isActive: true,
                emailVerified,
                firstName: 'Test',
                lastName: 'Member',
                tenantId: 'tenant-1',
                mustChangePassword: false,
              })),
              update: userUpdate,
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: string) =>
              ({
                'app.jwt.secret': JWT_SECRET,
                'app.jwt.refreshSecret': JWT_REFRESH_SECRET,
                'app.jwt.accessExpiration': '15m',
                'app.jwt.refreshExpiration': '7d',
                'app.features.emailVerificationEnforced': flag,
              })[key] ?? fallback,
            getOrThrow: (key: string) =>
              ({
                'app.jwt.secret': JWT_SECRET,
                'app.jwt.refreshSecret': JWT_REFRESH_SECRET,
              })[key] ??
              (() => {
                throw new Error(`Missing config ${key}`);
              })(),
          },
        },
        { provide: AuditService, useValue: { create: auditCreate } },
        { provide: JwtBlocklistService, useValue: { isBlocked: jest.fn(async () => false) } },
        { provide: SessionService, useValue: { rotateSession: jest.fn(async () => undefined) } },
        { provide: RedisService, useValue: {} },
        { provide: getQueueToken(QUEUE_NAMES.EMAIL), useValue: { add: jest.fn() } },
      ],
    }).compile();

    return {
      service: moduleRef.get(AuthService),
      auditCreate,
      userUpdate,
    };
  };

  it('blocks login for unverified users when the feature flag is enabled', async () => {
    const { service, auditCreate, userUpdate } = await buildService(false, 'true');

    await expect(
      service.login(
        { email: 'member@test.co.ke', password: 'TestPassword123!' },
        'tenant-1',
        '127.0.0.1',
      ),
    ).rejects.toThrow('Email not verified');

    expect(userUpdate).not.toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'LOGIN_ATTEMPT_UNVERIFIED_EMAIL',
        resourceId: 'user-1',
      }),
    );
  });

  it('allows unverified users when the feature flag is disabled', async () => {
    const { service, userUpdate } = await buildService(false, 'false');

    const result = await service.login(
      { email: 'member@test.co.ke', password: 'TestPassword123!' },
      'tenant-1',
      '127.0.0.1',
    );

    expect(result.accessToken).toBeDefined();
    expect(result.migrateRefreshToken).toBe(true);
    expect(userUpdate).toHaveBeenCalled();
  });
});
