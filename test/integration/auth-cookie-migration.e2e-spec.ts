import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { TenantStatus, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from 'express';
import { AuthController } from '../../src/modules/auth/auth.controller';
import { AuthService } from '../../src/modules/auth/auth.service';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';
import { JwtBlocklistService } from '../../src/modules/auth/jwt-blocklist.service';
import { SessionService } from '../../src/modules/auth/session.service';
import { OtpService } from '../../src/modules/auth/otp.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { RedisService } from '../../src/common/services/redis.service';
import { SmsService } from '../../src/modules/sms/sms.service';
import { QUEUE_NAMES } from '../../src/modules/queue/queue.constants';
import { JwtAuthGuard } from '../../src/common/guards/jwt.guard';
import { tenantAsyncStorage } from '../../src/common/services/tenant-context.service';

const JWT_SECRET = 'test-access-secret-at-least-32-chars-long';
const JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-32-chars-long';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';

type TestUser = {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  tenantId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  isActive: boolean;
  emailVerified: boolean;
  mustChangePassword: boolean;
  refreshToken: string | null;
  member: { id: string; memberNumber: string; kycStatus: string } | null;
};

const decodeBearerTenant = (authorization?: string): string | null => {
  if (!authorization?.startsWith('Bearer ')) return null;
  const [, payload] = authorization.slice('Bearer '.length).split('.');
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    return (JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as { tenantId?: string })
      .tenantId ?? null;
  } catch {
    return null;
  }
};

const cookieHeader = (headers: Record<string, unknown>): string => {
  const value = headers['set-cookie'];
  return Array.isArray(value) ? value.join(';') : String(value ?? '');
};

describe('Auth Cookie Migration', () => {
  let app: INestApplication;
  let users: Map<string, TestUser>;
  let redisStore: Map<string, string>;

  beforeAll(async () => {
    const passwordHash = await argon2.hash('TestPassword123!');
    users = new Map<string, TestUser>();
    redisStore = new Map<string, string>();

    const memberUser: TestUser = {
      id: 'user-cookie-member',
      email: 'member-cookie@test.co.ke',
      passwordHash,
      role: UserRole.MEMBER,
      tenantId: TENANT_ID,
      firstName: 'Cookie',
      lastName: 'Member',
      phone: '254722000001',
      isActive: true,
      emailVerified: true,
      mustChangePassword: false,
      refreshToken: null,
      member: { id: 'member-cookie-id', memberNumber: 'M-COOKIE-001', kycStatus: 'APPROVED' },
    };
    users.set(memberUser.id, memberUser);

    const prismaMock = {
      user: {
        findFirst: jest.fn(async (args: { where?: { tenantId?: string; id?: string } }) => {
          if (args.where?.id) {
            const user = users.get(args.where.id);
            return user && (!args.where.tenantId || user.tenantId === args.where.tenantId) ? user : null;
          }
          return [...users.values()].find((user) => user.email === memberUser.email) ?? null;
        }),
        findUnique: jest.fn(async (args: { where: { id: string } }) => users.get(args.where.id) ?? null),
        findFirstOrThrow: jest.fn(async (args: { where: { id: string; tenantId: string } }) => {
          const user = users.get(args.where.id);
          if (!user || user.tenantId !== args.where.tenantId) {
            throw new Error('User not found');
          }
          return {
            id: user.id,
            email: user.email,
            phone: user.phone,
            role: user.role,
            tenantId: user.tenantId,
            firstName: user.firstName,
            lastName: user.lastName,
            mustChangePassword: user.mustChangePassword,
            member: user.member,
          };
        }),
        update: jest.fn(async (args: { where: { id: string }; data: Partial<TestUser> }) => {
          const user = users.get(args.where.id);
          if (!user) throw new Error('User not found');
          Object.assign(user, args.data);
          return user;
        }),
      },
      tenant: {
        findUnique: jest.fn(async () => ({ id: TENANT_ID, status: TenantStatus.ACTIVE })),
      },
      refreshSession: {
        findFirst: jest.fn(async () => null),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
    };

    const redisMock = {
      set: jest.fn(async (key: string, value: string, ttlSeconds?: number) => {
        redisStore.set(key, `${value}:${ttlSeconds ?? 0}`);
        return true;
      }),
      exists: jest.fn(async (key: string) => redisStore.has(key)),
      del: jest.fn(async (key: string) => {
        redisStore.delete(key);
      }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: '15m' },
        }),
      ],
      controllers: [AuthController],
      providers: [
        AuthService,
        JwtStrategy,
        JwtBlocklistService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: PrismaService, useValue: prismaMock },
        { provide: RedisService, useValue: redisMock },
        { provide: ConfigService, useValue: {
          get: (key: string, fallback?: string) => ({
            'app.jwt.secret': JWT_SECRET,
            'app.jwt.refreshSecret': JWT_REFRESH_SECRET,
            'app.jwt.accessExpiration': '15m',
            'app.jwt.refreshExpiration': '7d',
            'app.apiPrefix': 'api/v1',
          }[key] ?? fallback),
          getOrThrow: (key: string) => ({
            'app.jwt.secret': JWT_SECRET,
            'app.jwt.refreshSecret': JWT_REFRESH_SECRET,
          }[key] ?? (() => { throw new Error(`Missing config: ${key}`); })()),
        } },
        { provide: AuditService, useValue: { create: jest.fn(async () => undefined) } },
        { provide: SessionService, useValue: { rotateSession: jest.fn(async () => undefined) } },
        { provide: OtpService, useValue: { generate: jest.fn(), validate: jest.fn(), delete: jest.fn() } },
        { provide: SmsService, useValue: { enqueueSms: jest.fn(async () => undefined) } },
        { provide: getQueueToken(QUEUE_NAMES.EMAIL), useValue: { add: jest.fn(async () => undefined) } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.use((req: ExpressRequest & { tenant?: { id: string }; tenantId?: string }, res: ExpressResponse, next: NextFunction) => {
      const tenantId = req.headers['x-tenant-id'];
      const headerTenant = Array.isArray(tenantId) ? tenantId[0] : tenantId;
      if (!headerTenant || typeof headerTenant !== 'string') {
        res.status(400).json({ message: 'X-Tenant-ID header is required' });
        return;
      }

      const tokenTenant = decodeBearerTenant(req.headers.authorization);
      if (tokenTenant && tokenTenant !== headerTenant) {
        res.status(403).json({ message: 'Token tenant does not match X-Tenant-ID' });
        return;
      }

      req.tenant = { id: headerTenant };
      req.tenantId = headerTenant;
      tenantAsyncStorage.run({ tenantId: headerTenant }, () => next());
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('sets refresh cookie on login and still supports legacy body refresh', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-ID', TENANT_ID)
      .send({ email: 'member-cookie@test.co.ke', password: 'TestPassword123!' })
      .expect(200);

    expect(cookieHeader(login.headers)).toContain('refresh_token=');
    expect(cookieHeader(login.headers)).toContain('Path=/api/v1/auth');
    expect(login.body.data.migrateRefreshToken).toBe(true);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('X-Tenant-ID', TENANT_ID)
      .send({ refreshToken: login.body.data.refreshToken })
      .expect(200)
      .expect((res) => {
        expect(res.body.data.accessToken).toBeDefined();
        expect(cookieHeader(res.headers)).toContain('refresh_token=');
        expect(cookieHeader(res.headers)).toContain('Path=/api/v1/auth');
      });
  });

  it('returns tenant-scoped /auth/me profile', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-ID', TENANT_ID)
      .send({ email: 'member-cookie@test.co.ke', password: 'TestPassword123!' })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('X-Tenant-ID', TENANT_ID)
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.data.email).toBe('member-cookie@test.co.ke');
        expect(res.body.data.member.memberNumber).toBe('M-COOKIE-001');
      });

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('X-Tenant-ID', OTHER_TENANT_ID)
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .expect(403);
  });

  it('clears cookie on logout and blocks the current access token JTI', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-ID', TENANT_ID)
      .send({ email: 'member-cookie@test.co.ke', password: 'TestPassword123!' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('X-Tenant-ID', TENANT_ID)
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .expect(204)
      .expect((res) => {
        expect(cookieHeader(res.headers)).toContain('refresh_token=');
        expect(cookieHeader(res.headers)).toContain('Expires=Thu, 01 Jan 1970');
        expect(cookieHeader(res.headers)).toContain('Path=/api/v1/auth');
      });

    expect([...redisStore.keys()].some((key) => key.startsWith('blocklist:access:'))).toBe(true);
    expect(
      [...redisStore.keys()].some(
        (key) => key.startsWith('blocklist:') && !key.startsWith('blocklist:access:'),
      ),
    ).toBe(true);

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('X-Tenant-ID', TENANT_ID)
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .expect(401);
  });
});
