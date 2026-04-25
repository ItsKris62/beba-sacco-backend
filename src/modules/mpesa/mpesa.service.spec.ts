import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MpesaService } from './mpesa.service';
import { RedisService } from '../../common/services/redis.service';
import { DarajaClientService } from './daraja-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MpesaTriggerSource } from '@prisma/client';
import { DepositPurpose } from './dto/deposit-request.dto';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockConfig = {
  get: jest.fn((key: string, def?: unknown) => {
    const map: Record<string, unknown> = {
      'app.mpesa.stkRateLimitPerDay': 3,
      'app.mpesa.callbackUrl': 'https://api.example.com',
      'app.mpesa.webhookSecret': 'test-secret',
    };
    return map[key] ?? def;
  }),
} as unknown as ConfigService;

const mockPrisma = {
  member: {
    findFirst: jest.fn().mockResolvedValue({ id: 'member-1' }),
  },
  mpesaTransaction: {
    create: jest.fn().mockResolvedValue({ id: 'mpesa-tx-1' }),
  },
  account: {
    findFirst: jest.fn().mockResolvedValue({ id: 'acct-1', tenantId: 'tenant-1' }),
  },
  loan: {
    findFirst: jest.fn().mockResolvedValue(null),
  },
} as unknown as PrismaService;

const mockDaraja = {
  initiateSTKPush: jest.fn().mockResolvedValue({
    CheckoutRequestID: 'ws_CO_001',
    MerchantRequestID: 'mr-001',
    CustomerMessage: 'Success',
  }),
} as unknown as DarajaClientService;

const mockCallbackQueue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
const mockDisbursementQueue = { add: jest.fn() };
const mockDlqQueue = { add: jest.fn() };

function makeRedis(incrResult: number): RedisService {
  return {
    incrWithExpireAt: jest.fn().mockResolvedValue(incrResult),
    incr: jest.fn().mockResolvedValue(incrResult),
    expire: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(true),
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(true),
  } as unknown as RedisService;
}

function makeService(incrResult = 1): MpesaService {
  return new MpesaService(
    mockConfig,
    mockPrisma,
    makeRedis(incrResult),
    mockDaraja,
    mockCallbackQueue as never,
    mockDisbursementQueue as never,
    mockDlqQueue as never,
  );
}

const BASE_DTO = {
  phoneNumber: '254712345678',
  amount: 1000,
  purpose: DepositPurpose.SAVINGS,
  accountRef: 'ACC-001',
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('MpesaService.initiateDeposit [M-6, M-1]', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    (mockPrisma.member.findFirst as jest.Mock).mockResolvedValue({ id: 'member-1' });
    (mockPrisma.account.findFirst as jest.Mock).mockResolvedValue({ id: 'acct-1', tenantId: 'tenant-1' });
    (mockDaraja.initiateSTKPush as jest.Mock).mockResolvedValue({
      CheckoutRequestID: 'ws_CO_001',
      MerchantRequestID: 'mr-001',
      CustomerMessage: 'Success',
    });
  });

  // ── [M-6] Math.round not Math.ceil ──────────────────────────────────────

  it('[M-6] rounds fractional amounts (x.5 rounds up, not always ceil)', async () => {
    const service = makeService(1);
    const dto = { ...BASE_DTO, amount: 100.5 };
    await service.initiateDeposit(dto, 'tenant-1', 'user-1', 'user-1', MpesaTriggerSource.MEMBER);

    const stkCall = (mockDaraja.initiateSTKPush as jest.Mock).mock.calls[0][0];
    expect(stkCall.amount).toBe(101); // Math.round(100.5) = 101
  });

  it('[M-6] rounds 100.4 down to 100, not up to 101 (Math.ceil would give 101)', async () => {
    const service = makeService(1);
    const dto = { ...BASE_DTO, amount: 100.4 };
    await service.initiateDeposit(dto, 'tenant-1', 'user-1', 'user-1', MpesaTriggerSource.MEMBER);

    const stkCall = (mockDaraja.initiateSTKPush as jest.Mock).mock.calls[0][0];
    // Math.ceil(100.4) = 101 (WRONG — overcharges member)
    // Math.round(100.4) = 100 (CORRECT)
    expect(stkCall.amount).toBe(100);
  });

  it('[M-6] passes integer amounts through unchanged', async () => {
    const service = makeService(1);
    await service.initiateDeposit(BASE_DTO, 'tenant-1', 'user-1', 'user-1', MpesaTriggerSource.MEMBER);

    const stkCall = (mockDaraja.initiateSTKPush as jest.Mock).mock.calls[0][0];
    expect(stkCall.amount).toBe(1000);
  });

  // ── [M-1] Atomic rate-limit counter ─────────────────────────────────────

  it('[M-1] calls incrWithExpireAt (not incr + expire) for rate limiting', async () => {
    const redis = makeRedis(1);
    const service = new MpesaService(
      mockConfig,
      mockPrisma,
      redis,
      mockDaraja,
      mockCallbackQueue as never,
      mockDisbursementQueue as never,
      mockDlqQueue as never,
    );

    await service.initiateDeposit(BASE_DTO, 'tenant-1', 'user-1', 'user-1', MpesaTriggerSource.MEMBER);

    expect(redis.incrWithExpireAt).toHaveBeenCalledTimes(1);
    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('[M-1] passes a future timestamp (midnight EAT) to incrWithExpireAt', async () => {
    const redis = makeRedis(1);
    const service = new MpesaService(
      mockConfig,
      mockPrisma,
      redis,
      mockDaraja,
      mockCallbackQueue as never,
      mockDisbursementQueue as never,
      mockDlqQueue as never,
    );

    const before = Date.now();
    await service.initiateDeposit(BASE_DTO, 'tenant-1', 'user-1', 'user-1', MpesaTriggerSource.MEMBER);
    const after = Date.now();

    const [, expireAtMs] = (redis.incrWithExpireAt as jest.Mock).mock.calls[0];
    // expireAtMs must be in the future (at least 1 second from now)
    expect(expireAtMs).toBeGreaterThan(before);
    // and no more than 24h from now
    expect(expireAtMs).toBeLessThanOrEqual(after + 86_400_001);
  });

  // ── Rate limit enforcement ─────────────────────────────────────────────

  it('throws BadRequestException when daily rate limit is exceeded', async () => {
    const service = makeService(4); // maxPerDay = 3, currentCount = 4

    await expect(
      service.initiateDeposit(BASE_DTO, 'tenant-1', 'user-1', 'user-1', MpesaTriggerSource.MEMBER),
    ).rejects.toThrow(BadRequestException);
  });

  it('allows exactly maxPerDay requests (boundary: count === limit)', async () => {
    const service = makeService(3); // count === limit → allowed

    await expect(
      service.initiateDeposit(BASE_DTO, 'tenant-1', 'user-1', 'user-1', MpesaTriggerSource.MEMBER),
    ).resolves.toBeDefined();
  });
});
