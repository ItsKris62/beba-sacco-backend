/**
 * Test Application Factory
 *
 * Provides a clean NestJS app instance for E2E tests with:
 * - In-memory PostgreSQL (via testcontainers or TEST_DATABASE_URL)
 * - Redis (testcontainers or TEST_REDIS_URL)
 * - Full seed data (tenant, admin, member, loan product, accounts)
 * - RFC 7807 problem+json response parsing helpers
 *
 * USAGE:
 *   const { app, prisma, redis, teardown, seed } = await TestAppFactory.create();
 *   // ... run tests ...
 *   await teardown();
 */
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisService } from '../../src/common/services/redis.service';
import { UserRole, LoanStatus, GuarantorStatus, AccountType } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import * as argon2 from 'argon2';
import { QUEUE_NAMES } from '../../src/modules/queue/queue.constants';

export interface TestSeed {
  tenantId: string;
  tenantSlug: string;
  adminUserId: string;
  adminToken: string;
  memberUserId: string;
  memberToken: string;
  memberId: string;
  memberAccountId: string;
  loanProductId: string;
  loanId: string;
  guarantorMemberId: string;
  guarantorUserId: string;
  guarantorToken: string;
  reportJobId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface TestAppContext {
  app: INestApplication;
  prisma: PrismaService;
  redis: RedisService;
  seed: TestSeed;
  teardown: () => Promise<void>;
  request: () => any;
}

export class TestAppFactory {
  static async create(): Promise<TestAppContext> {
    const mockRedis = this.createMockRedis();
    const mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'test-job' }),
      addBulk: jest.fn().mockResolvedValue([]),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
    let builder = Test.createTestingModule({
      imports: [AppModule],
    }).overrideProvider(RedisService).useValue(mockRedis);

    for (const queueName of Object.values(QUEUE_NAMES)) {
      builder = builder.overrideProvider(getQueueToken(queueName)).useValue(mockQueue);
    }

    const moduleRef = await builder.compile();

    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );

    // Prevent pino from logging during tests
    app.useLogger({ log: () => {}, error: () => {}, warn: () => {}, debug: () => {} });

    await app.init();

    const prisma = app.get(PrismaService);
    const redis = app.get(RedisService);

    // Clean slate
    await this.cleanDatabase(prisma);
    await redis.delPattern('idempotency:*');
    await redis.delPattern('DASH:*');
    await redis.delPattern('loan:*');

    const seed = await this.seedTestData(prisma, redis, app);

    const teardown = async () => {
      await this.cleanDatabase(prisma);
      await redis.delPattern('idempotency:*');
      await redis.delPattern('DASH:*');
      await redis.delPattern('loan:*');
      await app.close();
    };

    return {
      app,
      prisma,
      redis,
      seed,
      teardown,
      request: () => request(app.getHttpServer()),
    };
  }

  private static async cleanDatabase(prisma: PrismaService): Promise<void> {
    const tables = [
      'LoanRepayment', 'LoanGuarantor', 'Guarantor', 'Transaction', 'MpesaTransaction',
      'Loan', 'Account', 'Member', 'LoanProduct', 'AuditLog',
      'TenantCounter', 'ReportJob', 'StageAssignment', 'MemberStage', 'User', 'Tenant',
    ];
    for (const table of tables) {
      try {
        await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE 1=1`);
      } catch {
        // Ignore errors for tables that may not exist in all migrations
      }
    }
  }

  private static createMockRedis(): RedisService {
    const store = new Map<string, string>();
    const matches = (pattern: string, key: string) => {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`).test(key);
    };
    return {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string, _ttl?: number, nx?: boolean) => {
        if (nx && store.has(key)) return false;
        store.set(key, value);
        return true;
      },
      del: async (key: string) => { store.delete(key); },
      exists: async (key: string) => store.has(key),
      delPattern: async (pattern: string) => {
        const keys = [...store.keys()].filter((key) => matches(pattern, key));
        keys.forEach((key) => store.delete(key));
        return keys.length;
      },
      getJson: async <T>(key: string) => {
        const raw = store.get(key);
        return raw ? JSON.parse(raw) as T : null;
      },
      setJson: async <T>(key: string, value: T) => {
        store.set(key, JSON.stringify(value));
        return true;
      },
      incr: async (key: string) => {
        const next = Number(store.get(key) ?? '0') + 1;
        store.set(key, String(next));
        return next;
      },
      incrBy: async (key: string, amount: number) => {
        const next = Number(store.get(key) ?? '0') + amount;
        store.set(key, String(next));
        return next;
      },
      incrWithExpireAt: async (key: string) => {
        const next = Number(store.get(key) ?? '0') + 1;
        store.set(key, String(next));
        return next;
      },
      expire: async () => undefined,
      ttl: async () => -1,
      scanKeys: async (pattern: string) => [...store.keys()].filter((key) => matches(pattern, key)),
      publish: async () => undefined,
      ping: async () => true,
      onModuleDestroy: () => undefined,
    } as unknown as RedisService;
  }

  private static async seedTestData(
    prisma: PrismaService,
    _redis: RedisService,
    app: INestApplication,
  ): Promise<TestSeed> {
    const tenantId = uuidv4();
    const tenantSlug = 'test-sacco';
    const passwordHash = await argon2.hash('TestPassword123!');

    // Tenant
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Test SACCO',
        slug: tenantSlug,
        schemaName: `tenant_${tenantSlug}`,
        status: 'ACTIVE',
        contactEmail: 'test@sacco.co.ke',
        contactPhone: '254700000000',
      },
    });

    // Tenant counter
    await prisma.tenantCounter.create({
      data: { tenantId, memberSeq: 0, accountSeq: 0, loanSeq: 0 },
    });

    // Admin user (MANAGER)
    const adminUserId = uuidv4();
    await prisma.user.create({
      data: {
        id: adminUserId,
        tenantId,
        email: 'admin@test-sacco.co.ke',
        passwordHash,
        role: UserRole.MANAGER,
        firstName: 'Admin',
        lastName: 'User',
        phone: '254711111111',
        isActive: true,
        emailVerified: true,
        status: 'APPROVED',
      },
    });

    // Member user
    const memberUserId = uuidv4();
    await prisma.user.create({
      data: {
        id: memberUserId,
        tenantId,
        email: 'member@test-sacco.co.ke',
        passwordHash,
        role: UserRole.MEMBER,
        firstName: 'Member',
        lastName: 'User',
        phone: '254722222222',
        isActive: true,
        emailVerified: true,
        status: 'APPROVED',
      },
    });

    // Member profile
    const memberId = uuidv4();
    await prisma.member.create({
      data: {
        id: memberId,
        tenantId,
        userId: memberUserId,
        memberNumber: 'M-000001',
        nationalId: '12345678',
        isActive: true,
        kycStatus: 'APPROVED',
      },
    });

    // FOSA account
    const memberAccountId = uuidv4();
    await prisma.account.create({
      data: {
        id: memberAccountId,
        tenantId,
        memberId,
        accountNumber: 'ACC-FOSA-000001',
        accountType: AccountType.FOSA,
        balance: new Decimal(10000).toDecimalPlaces(4).toString(),
        isActive: true,
        version: 0,
      },
    });

    // BOSA account
    await prisma.account.create({
      data: {
        id: uuidv4(),
        tenantId,
        memberId,
        accountNumber: 'ACC-BOSA-000001',
        accountType: AccountType.BOSA,
        balance: new Decimal(5000).toDecimalPlaces(4).toString(),
        isActive: true,
        version: 0,
      },
    });

    // Loan product
    const loanProductId = uuidv4();
    await prisma.loanProduct.create({
      data: {
        id: loanProductId,
        tenantId,
        name: 'Development Loan',
        minAmount: new Decimal(1000).toDecimalPlaces(4).toString(),
        maxAmount: new Decimal(100000).toDecimalPlaces(4).toString(),
        interestRate: new Decimal(0.12).toDecimalPlaces(4).toString(),
        interestType: 'REDUCING_BALANCE',
        maxTenureMonths: 12,
        processingFeeRate: new Decimal(0.02).toDecimalPlaces(4).toString(),
        isActive: true,
      },
    });

    // Loan (APPROVED, ready for disbursement)
    const loanId = uuidv4();
    await prisma.loan.create({
      data: {
        id: loanId,
        tenantId,
        memberId,
        loanProductId,
        loanNumber: 'LN-2026-000001',
        status: LoanStatus.APPROVED,
        principalAmount: new Decimal(50000).toDecimalPlaces(4).toString(),
        interestRate: new Decimal(0.12).toDecimalPlaces(4).toString(),
        processingFee: new Decimal(1000).toDecimalPlaces(4).toString(),
        tenureMonths: 6,
        gracePeriodMonths: 0,
        monthlyInstalment: new Decimal(8805.17).toDecimalPlaces(4).toString(),
        outstandingBalance: new Decimal(50000).toDecimalPlaces(4).toString(),
        totalRepaid: new Decimal(0).toDecimalPlaces(4).toString(),
        appliedAt: new Date(),
        approvedAt: new Date(),
        approvedBy: adminUserId,
      },
    });

    // Guarantor member
    const guarantorUserId = uuidv4();
    await prisma.user.create({
      data: {
        id: guarantorUserId,
        tenantId,
        email: 'guarantor@test-sacco.co.ke',
        passwordHash,
        role: UserRole.MEMBER,
        firstName: 'Guarantor',
        lastName: 'User',
        phone: '254733333333',
        isActive: true,
        emailVerified: true,
        status: 'APPROVED',
      },
    });

    const guarantorMemberId = uuidv4();
    await prisma.member.create({
      data: {
        id: guarantorMemberId,
        tenantId,
        userId: guarantorUserId,
        memberNumber: 'M-000002',
        nationalId: '87654321',
        isActive: true,
        kycStatus: 'APPROVED',
      },
    });

    // Guarantor FOSA account (must have balance to guarantee)
    await prisma.account.create({
      data: {
        id: uuidv4(),
        tenantId,
        memberId: guarantorMemberId,
        accountNumber: 'ACC-FOSA-000002',
        accountType: AccountType.FOSA,
        balance: new Decimal(60000).toDecimalPlaces(4).toString(),
        isActive: true,
        version: 0,
      },
    });

    // Pending guarantor for loan
    await prisma.loanGuarantor.create({
      data: {
        id: uuidv4(),
        tenantId,
        loanId,
        memberId: guarantorMemberId,
        status: GuarantorStatus.PENDING,
        guaranteedAmount: new Decimal(50000).toDecimalPlaces(4).toString(),
      },
    });

    // Report job
    const reportJobId = uuidv4();
    await (prisma as any).reportJob?.create?.({
      data: {
        id: reportJobId,
        tenantId,
        reportType: 'LOAN_BOOK',
        format: 'PDF',
        status: 'QUEUED',
        requestedBy: adminUserId,
      },
    }).catch(() => {
      // ReportJob may not be in all migrations yet
    });

    // Generate tokens via auth endpoint
    const req = request(app.getHttpServer());

    const adminLogin = await req
      .post('/api/auth/login')
      .set('X-Tenant-ID', tenantId)
      .send({ email: 'admin@test-sacco.co.ke', password: 'TestPassword123!' });

    const memberLogin = await req
      .post('/api/auth/login')
      .set('X-Tenant-ID', tenantId)
      .send({ email: 'member@test-sacco.co.ke', password: 'TestPassword123!' });

    const guarantorLogin = await req
      .post('/api/auth/login')
      .set('X-Tenant-ID', tenantId)
      .send({ email: 'guarantor@test-sacco.co.ke', password: 'TestPassword123!' });

    return {
      tenantId,
      tenantSlug,
      adminUserId,
      adminToken: adminLogin.body.accessToken ?? adminLogin.body.data?.accessToken ?? '',
      memberUserId,
      memberToken: memberLogin.body.accessToken ?? memberLogin.body.data?.accessToken ?? '',
      memberId,
      memberAccountId,
      loanProductId,
      loanId,
      guarantorMemberId,
      guarantorUserId,
      guarantorToken: guarantorLogin.body.accessToken ?? guarantorLogin.body.data?.accessToken ?? '',
      reportJobId,
    };
  }
}
