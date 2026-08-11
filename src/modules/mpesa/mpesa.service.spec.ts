import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MpesaService } from './mpesa.service';
import { RedisService } from '../../common/services/redis.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { DarajaClientService } from './daraja-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MpesaTxType, MpesaTriggerSource, TransactionStatus } from '@prisma/client';
import { DepositPurpose } from './dto/deposit-request.dto';
import { LoanRepaymentService } from '../loans/loan-repayment.service';
import {
  B2cProviderUnavailableException,
  MwaloniAuthException,
} from './exceptions/mpesa.exceptions';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockConfig = {
  get: jest.fn((key: string, def?: unknown) => {
    const map: Record<string, unknown> = {
      'app.mpesa.stkRateLimitPerDay': 3,
      'app.mpesa.callbackUrl': 'https://api.example.com',
      'app.mpesa.webhookSecret': 'test-secret',
      'app.mpesa.b2cShortcode': '600000',
      'app.mpesa.initiatorName': 'testapi',
      'app.mpesa.securityCredential': 'test-credential',
      'app.mpesa.b2cResultUrl': 'https://api.example.com/mpesa/b2c/result',
      'app.mpesa.b2cQueueTimeoutUrl': 'https://api.example.com/mpesa/b2c/timeout',
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
    findFirst: jest.fn().mockResolvedValue(null),
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
  initiateB2C: jest.fn().mockResolvedValue({
    ConversationID: 'conv-001',
    OriginatorConversationID: 'orig-001',
    ResponseCode: '0',
    ResponseDescription: 'Accept the service request successfully.',
  }),
} as unknown as DarajaClientService;

const mockCallbackQueue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
const mockDisbursementQueue = { add: jest.fn().mockResolvedValue({ id: 'disb-job-1' }) };
const mockB2cTimeoutQueue = { add: jest.fn().mockResolvedValue({ id: 'b2c-timeout-job-1' }) };
const mockDlqQueue = { add: jest.fn() };
const mockIdempotency = {
  checkAndReserve: jest.fn().mockResolvedValue({ status: 'RESERVED' }),
  complete: jest.fn().mockResolvedValue(undefined),
  release: jest.fn().mockResolvedValue(undefined),
} as unknown as IdempotencyService;

const mockAudit = {
  create: jest.fn().mockResolvedValue(undefined),
  createAtomic: jest.fn().mockResolvedValue(undefined),
} as unknown as AuditService;

const mockLoanRepaymentService = {
  validateLoanForRepayment: jest.fn().mockResolvedValue({ id: 'loan-1', status: 'ACTIVE' }),
} as unknown as LoanRepaymentService;

function makeRedis(incrResult: number): RedisService {
  return {
    incrWithExpireAt: jest.fn().mockResolvedValue(incrResult),
    incr: jest.fn().mockResolvedValue(incrResult),
    expire: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(true),
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(true),
    decrIfPositive: jest.fn().mockResolvedValue(0),
  } as unknown as RedisService;
}

function makeService(incrResult = 1): MpesaService {
  return new MpesaService(
    mockConfig,
    mockPrisma,
    makeRedis(incrResult),
    mockIdempotency,
    mockDaraja,
    mockAudit,
    mockLoanRepaymentService,
    mockCallbackQueue as never,
    mockDisbursementQueue as never,
    mockB2cTimeoutQueue as never,
    mockDlqQueue as never,
  );
}

function makeServiceWithMwaloni(mwaloni: unknown): MpesaService {
  return new MpesaService(
    mockConfig,
    mockPrisma,
    makeRedis(1),
    mockIdempotency,
    mockDaraja,
    mockAudit,
    mockLoanRepaymentService,
    mockCallbackQueue as never,
    mockDisbursementQueue as never,
    mockB2cTimeoutQueue as never,
    mockDlqQueue as never,
    undefined,
    mwaloni as never,
  );
}

const BASE_DTO = {
  phoneNumber: '254712345678',
  amount: 1000,
  purpose: DepositPurpose.SAVINGS,
  accountRef: 'ACC-001',
};

// ─── Suite: rounding + rate-limit atomicity [M-6, M-1] ───────────────────────

describe('MpesaService.initiateDeposit [M-6, M-1]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockPrisma.member.findFirst as jest.Mock).mockResolvedValue({ id: 'member-1' });
    (mockPrisma.account.findFirst as jest.Mock).mockResolvedValue({
      id: 'acct-1',
      tenantId: 'tenant-1',
    });
    (mockDaraja.initiateSTKPush as jest.Mock).mockResolvedValue({
      CheckoutRequestID: 'ws_CO_001',
      MerchantRequestID: 'mr-001',
      CustomerMessage: 'Success',
    });
    (mockIdempotency.checkAndReserve as jest.Mock).mockResolvedValue({ status: 'RESERVED' });
    (mockIdempotency.complete as jest.Mock).mockResolvedValue(undefined);
    (mockIdempotency.release as jest.Mock).mockResolvedValue(undefined);
  });

  // ── [M-6] Math.round not Math.ceil ──────────────────────────────────────

  it('[M-6] rounds fractional amounts (x.5 rounds up, not always ceil)', async () => {
    const service = makeService(1);
    const dto = { ...BASE_DTO, amount: 100.5 };
    await service.initiateDeposit(
      dto,
      'tenant-1',
      'user-1',
      'user-1',
      MpesaTriggerSource.MEMBER,
      'idem-1',
    );

    const stkCall = (mockDaraja.initiateSTKPush as jest.Mock).mock.calls[0][0];
    expect(stkCall.amount).toBe(101); // Math.round(100.5) = 101
  });

  it('[M-6] rounds 100.4 down to 100, not up to 101 (Math.ceil would give 101)', async () => {
    const service = makeService(1);
    const dto = { ...BASE_DTO, amount: 100.4 };
    await service.initiateDeposit(
      dto,
      'tenant-1',
      'user-1',
      'user-1',
      MpesaTriggerSource.MEMBER,
      'idem-1',
    );

    const stkCall = (mockDaraja.initiateSTKPush as jest.Mock).mock.calls[0][0];
    // Math.ceil(100.4) = 101 (WRONG — overcharges member)
    // Math.round(100.4) = 100 (CORRECT)
    expect(stkCall.amount).toBe(100);
  });

  it('[M-6] passes integer amounts through unchanged', async () => {
    const service = makeService(1);
    await service.initiateDeposit(
      BASE_DTO,
      'tenant-1',
      'user-1',
      'user-1',
      MpesaTriggerSource.MEMBER,
      'idem-1',
    );

    const stkCall = (mockDaraja.initiateSTKPush as jest.Mock).mock.calls[0][0];
    expect(stkCall.amount).toBe(1000);
  });

  it('keeps STK deposits on Daraja and does not use Mwaloni', async () => {
    const mwaloni = {
      isEnabled: jest.fn().mockReturnValue(true),
      sendMobile: jest.fn(),
      fetchBalance: jest.fn(),
    };
    const service = makeServiceWithMwaloni(mwaloni);

    await service.initiateDeposit(
      BASE_DTO,
      'tenant-1',
      'user-1',
      'user-1',
      MpesaTriggerSource.MEMBER,
      'idem-1',
    );

    expect(mockDaraja.initiateSTKPush).toHaveBeenCalledTimes(1);
    expect(mwaloni.sendMobile).not.toHaveBeenCalled();
    expect(mwaloni.fetchBalance).not.toHaveBeenCalled();
  });

  // ── [M-1] Atomic rate-limit counter ─────────────────────────────────────

  it('[M-1] calls incrWithExpireAt (not incr + expire) for rate limiting', async () => {
    const redis = makeRedis(1);
    const service = new MpesaService(
      mockConfig,
      mockPrisma,
      redis,
      mockIdempotency,
      mockDaraja,
      mockAudit,
      mockLoanRepaymentService,
      mockCallbackQueue as never,
      mockDisbursementQueue as never,
      mockB2cTimeoutQueue as never,
      mockDlqQueue as never,
    );

    await service.initiateDeposit(
      BASE_DTO,
      'tenant-1',
      'user-1',
      'user-1',
      MpesaTriggerSource.MEMBER,
      'idem-1',
    );

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
      mockIdempotency,
      mockDaraja,
      mockAudit,
      mockLoanRepaymentService,
      mockCallbackQueue as never,
      mockDisbursementQueue as never,
      mockB2cTimeoutQueue as never,
      mockDlqQueue as never,
    );

    const before = Date.now();
    await service.initiateDeposit(
      BASE_DTO,
      'tenant-1',
      'user-1',
      'user-1',
      MpesaTriggerSource.MEMBER,
      'idem-1',
    );
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
      service.initiateDeposit(
        BASE_DTO,
        'tenant-1',
        'user-1',
        'user-1',
        MpesaTriggerSource.MEMBER,
        'idem-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('allows exactly maxPerDay requests (boundary: count === limit)', async () => {
    const service = makeService(3); // count === limit → allowed

    await expect(
      service.initiateDeposit(
        BASE_DTO,
        'tenant-1',
        'user-1',
        'user-1',
        MpesaTriggerSource.MEMBER,
        'idem-1',
      ),
    ).resolves.toBeDefined();
  });
});

// ─── Suite: initiateDeposit – SAVINGS full flow ───────────────────────────────

describe('MpesaService.initiateDeposit – SAVINGS flow', () => {
  let service: MpesaService;

  beforeEach(() => {
    jest.clearAllMocks();
    (mockPrisma.member.findFirst as jest.Mock).mockResolvedValue({ id: 'member-1' });
    (mockPrisma.account.findFirst as jest.Mock).mockResolvedValue({
      id: 'acct-1',
      tenantId: 'tenant-1',
    });
    (mockPrisma.mpesaTransaction.create as jest.Mock).mockResolvedValue({ id: 'mpesa-tx-1' });
    (mockDaraja.initiateSTKPush as jest.Mock).mockResolvedValue({
      CheckoutRequestID: 'ws_CO_001',
      MerchantRequestID: 'mr-001',
      CustomerMessage: 'Success. Request accepted for processing',
    });
    (mockIdempotency.checkAndReserve as jest.Mock).mockResolvedValue({ status: 'RESERVED' });
    (mockIdempotency.complete as jest.Mock).mockResolvedValue(undefined);
    (mockAudit.create as jest.Mock).mockResolvedValue(undefined);
    service = makeService(1);
  });

  it('checks and reserves the idempotency key derived from tenant, member, and caller key', async () => {
    await service.initiateDeposit(
      BASE_DTO,
      'tenant-1',
      'user-1',
      'user-1',
      MpesaTriggerSource.MEMBER,
      'idem-key-1',
    );

    expect(mockIdempotency.checkAndReserve).toHaveBeenCalledTimes(1);
    const [idemKey, tenantId] = (mockIdempotency.checkAndReserve as jest.Mock).mock.calls[0];
    expect(idemKey).toBe('mpesa:stk:tenant-1:member-1:idem-key-1');
    expect(tenantId).toBe('tenant-1');
  });

  it('calls initiateSTKPush with Math.round(amount) and the raw accountRef for SAVINGS', async () => {
    const dto = { ...BASE_DTO, amount: 1500.7 };
    await service.initiateDeposit(
      dto,
      'tenant-1',
      'user-1',
      'user-1',
      MpesaTriggerSource.MEMBER,
      'idem-1',
    );

    expect(mockDaraja.initiateSTKPush).toHaveBeenCalledTimes(1);
    const stkArgs = (mockDaraja.initiateSTKPush as jest.Mock).mock.calls[0][0];
    expect(stkArgs.amount).toBe(1501); // Math.round(1500.7)
    expect(stkArgs.accountReference).toBe('ACC-001');
    expect(stkArgs.phoneNumber).toBe('254712345678');
  });

  it('creates a PENDING STK_PUSH MpesaTransaction with correct fields', async () => {
    await service.initiateDeposit(
      BASE_DTO,
      'tenant-1',
      'user-1',
      'user-1',
      MpesaTriggerSource.MEMBER,
      'idem-1',
    );

    expect(mockPrisma.mpesaTransaction.create).toHaveBeenCalledTimes(1);
    const { data } = (mockPrisma.mpesaTransaction.create as jest.Mock).mock.calls[0][0];
    expect(data.status).toBe(TransactionStatus.PENDING);
    expect(data.type).toBe(MpesaTxType.STK_PUSH);
    expect(data.checkoutRequestId).toBe('ws_CO_001');
    expect(data.merchantRequestId).toBe('mr-001');
    expect(data.tenantId).toBe('tenant-1');
    expect(data.memberId).toBe('member-1');
    expect(data.phoneNumber).toBe('254712345678');
    expect(data.accountReference).toBe('ACC-001');
  });

  it('emits an MPESA.DEPOSIT.INITIATED audit log with entity and tenant context', async () => {
    await service.initiateDeposit(
      BASE_DTO,
      'tenant-1',
      'user-1',
      'user-1',
      MpesaTriggerSource.MEMBER,
      'idem-1',
    );

    expect(mockAudit.create).toHaveBeenCalledTimes(1);
    const auditArgs = (mockAudit.create as jest.Mock).mock.calls[0][0];
    expect(auditArgs.action).toBe('MPESA.DEPOSIT.INITIATED');
    expect(auditArgs.entityType).toBe('MpesaTransaction');
    expect(auditArgs.entityId).toBe('mpesa-tx-1');
    expect(auditArgs.tenantId).toBe('tenant-1');
    expect(auditArgs.actorId).toBe('user-1');
  });

  it('returns checkoutRequestId, customerMessage, and mpesaTxId on success', async () => {
    const result = await service.initiateDeposit(
      BASE_DTO,
      'tenant-1',
      'user-1',
      'user-1',
      MpesaTriggerSource.MEMBER,
      'idem-1',
    );

    expect(result).toEqual({
      checkoutRequestId: 'ws_CO_001',
      customerMessage: 'Success. Request accepted for processing',
      merchantRequestId: 'mr-001',
      mpesaTxId: 'mpesa-tx-1',
    });
  });

  it('short-circuits and returns cached result when idempotency key is already COMPLETED', async () => {
    const cached = {
      checkoutRequestId: 'ws_CO_cached',
      customerMessage: 'Cached',
      mpesaTxId: 'mpesa-tx-cached',
    };
    (mockIdempotency.checkAndReserve as jest.Mock).mockResolvedValue({
      status: 'COMPLETED',
      result: cached,
    });

    const result = await service.initiateDeposit(
      BASE_DTO,
      'tenant-1',
      'user-1',
      'user-1',
      MpesaTriggerSource.MEMBER,
      'idem-1',
    );

    expect(result).toEqual(cached);
    expect(mockDaraja.initiateSTKPush).not.toHaveBeenCalled();
    expect(mockPrisma.mpesaTransaction.create).not.toHaveBeenCalled();
  });

  it('throws BadRequestException without calling Daraja when idempotency key is PROCESSING', async () => {
    (mockIdempotency.checkAndReserve as jest.Mock).mockResolvedValue({ status: 'PROCESSING' });

    await expect(
      service.initiateDeposit(
        BASE_DTO,
        'tenant-1',
        'user-1',
        'user-1',
        MpesaTriggerSource.MEMBER,
        'idem-1',
      ),
    ).rejects.toThrow(BadRequestException);

    expect(mockDaraja.initiateSTKPush).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when no idempotency key is supplied', async () => {
    await expect(
      service.initiateDeposit(
        BASE_DTO,
        'tenant-1',
        'user-1',
        'user-1',
        MpesaTriggerSource.MEMBER,
        '',
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

// ─── Suite: queueLoanDisbursement ────────────────────────────────────────────

describe('MpesaService.queueLoanDisbursement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks direct M-Pesa loan disbursement before loading loan data', async () => {
    const service = makeService(1);

    await expect(
      service.queueLoanDisbursement('loan-1', 'tenant-1', 'officer-user-1'),
    ).rejects.toThrow(BadRequestException);

    expect(mockPrisma.loan.findFirst).not.toHaveBeenCalled();
    expect(mockDisbursementQueue.add).not.toHaveBeenCalled();
  });

  it('keeps B2C queueing disabled for missing-loan and missing-phone cases too', async () => {
    const service = makeService(1);

    await expect(
      service.queueLoanDisbursement('nonexistent-loan', 'tenant-1', 'officer-1'),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.queueLoanDisbursement('loan-without-phone', 'tenant-1', 'officer-1'),
    ).rejects.toThrow(BadRequestException);

    expect(mockPrisma.loan.findFirst).not.toHaveBeenCalled();
    expect(mockDisbursementQueue.add).not.toHaveBeenCalled();
  });
});

// ─── Suite: executeB2cDisbursement ───────────────────────────────────────────

describe('MpesaService.executeB2cDisbursement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks direct B2C execution before Daraja and database writes', async () => {
    const service = makeService(1);

    await expect(
      service.executeB2cDisbursement(
        'loan-1',
        'LOAN_DISBURSEMENT',
        'tenant-1',
        '254712345678',
        50000,
        'officer-1',
      ),
    ).rejects.toThrow(BadRequestException);

    expect(mockPrisma.loan.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.mpesaTransaction.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.mpesaTransaction.create).not.toHaveBeenCalled();
    expect(mockDaraja.initiateB2C).not.toHaveBeenCalled();
  });

  it('keeps direct B2C execution disabled even for duplicate or missing loan scenarios', async () => {
    const service = makeService(1);

    await expect(
      service.executeB2cDisbursement(
        'loan-2',
        'LOAN_DISBURSEMENT',
        'tenant-1',
        '254712345678',
        50000,
        'officer-1',
      ),
    ).rejects.toThrow(BadRequestException);

    expect(mockPrisma.loan.findFirst).not.toHaveBeenCalled();
    expect(mockDaraja.initiateB2C).not.toHaveBeenCalled();
  });

  it('routes FOSA withdrawals through Mwaloni when enabled and links the ledger transaction', async () => {
    const prisma = {
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
      account: {
        findUnique: jest.fn().mockResolvedValue({
          memberId: 'member-1',
          accountNumber: 'FOSA-001',
        }),
      },
      mpesaTransaction: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'mpesa-tx-1',
          tenantId: 'tenant-1',
          memberId: 'member-1',
          referenceId: 'account-1',
          transactionId: 'ledger-tx-1',
          phoneNumber: '254712345678',
          amount: { toString: () => '500' },
          conversationId: 'MWD-ledger-tx-1',
          status: TransactionStatus.PENDING,
          resultCode: null,
          resultDesc: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'mpesa-tx-1',
          tenantId: 'tenant-1',
          memberId: 'member-1',
          referenceId: 'account-1',
          transactionId: 'ledger-tx-1',
          phoneNumber: '254712345678',
          amount: { toString: () => '500' },
          conversationId: 'MWD-ledger-tx-1',
          status: TransactionStatus.COMPLETED,
          resultCode: 0,
          resultDesc: 'Cashout was successful.',
        }),
        update: jest.fn().mockImplementation(({ data }) => ({
          id: 'mpesa-tx-1',
          tenantId: 'tenant-1',
          memberId: 'member-1',
          referenceId: 'account-1',
          transactionId: 'ledger-tx-1',
          phoneNumber: '254712345678',
          amount: { toString: () => '500' },
          conversationId: 'MWD-ledger-tx-1',
          status: data.status,
          resultCode: data.resultCode,
          resultDesc: data.resultDesc,
        })),
      },
    } as unknown as PrismaService;
    const mwaloni = {
      isEnabled: jest.fn().mockReturnValue(true),
      sendMobile: jest.fn().mockResolvedValue({
        status: '00',
        message: 'Cashout was successful.',
      }),
    };
    const service = new MpesaService(
      mockConfig,
      prisma,
      makeRedis(1),
      mockIdempotency,
      mockDaraja,
      mockAudit,
      mockLoanRepaymentService,
      mockCallbackQueue as never,
      mockDisbursementQueue as never,
      mockB2cTimeoutQueue as never,
      mockDlqQueue as never,
      undefined,
      mwaloni as never,
      {} as never,
    );

    const result = await service.executeB2cDisbursement(
      'account-1',
      'FOSA_WITHDRAWAL',
      'tenant-1',
      '254712345678',
      500,
      'user-1',
      'ledger-tx-1',
    );

    expect(result).toEqual({ conversationId: 'MWD-ledger-tx-1', mpesaTxId: 'mpesa-tx-1' });
    expect(mwaloni.sendMobile).toHaveBeenCalledWith(
      expect.objectContaining({
        orderNumber: 'MWD-ledger-tx-1',
        phoneNumber: '254712345678',
        amount: 500,
      }),
    );
    expect(prisma.mpesaTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          transactionId: 'ledger-tx-1',
          memberId: 'member-1',
          conversationId: 'MWD-ledger-tx-1',
          reference: 'B2C-MWD-ledger-tx-1',
        }),
      }),
    );
    expect(mockDaraja.initiateB2C).not.toHaveBeenCalled();
  });

  it('fails closed without invoking Daraja when Mwaloni is disabled', async () => {
    const prisma = {
      account: {
        findUnique: jest.fn().mockResolvedValue({
          memberId: 'member-1',
          accountNumber: 'FOSA-001',
        }),
      },
      mpesaTransaction: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    } as unknown as PrismaService;
    const mwaloni = {
      isEnabled: jest.fn().mockReturnValue(false),
      sendMobile: jest.fn(),
    };
    const service = new MpesaService(
      mockConfig,
      prisma,
      makeRedis(1),
      mockIdempotency,
      mockDaraja,
      mockAudit,
      mockLoanRepaymentService,
      mockCallbackQueue as never,
      mockDisbursementQueue as never,
      mockB2cTimeoutQueue as never,
      mockDlqQueue as never,
      undefined,
      mwaloni as never,
      {} as never,
    );

    await expect(
      service.executeB2cDisbursement(
        'account-1',
        'FOSA_WITHDRAWAL',
        'tenant-1',
        '254712345678',
        500,
        'user-1',
      ),
    ).rejects.toThrow(B2cProviderUnavailableException);

    expect(mwaloni.sendMobile).not.toHaveBeenCalled();
    expect(mockDaraja.initiateB2C).not.toHaveBeenCalled();
    expect(prisma.mpesaTransaction.create).not.toHaveBeenCalled();
  });

  it('does not fall back to Daraja when Mwaloni payout authentication fails', async () => {
    const prisma = {
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
      account: {
        findUnique: jest.fn().mockResolvedValue({
          memberId: 'member-1',
          accountNumber: 'FOSA-001',
        }),
      },
      mpesaTransaction: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'mpesa-tx-1',
          tenantId: 'tenant-1',
          memberId: 'member-1',
          referenceId: 'account-1',
          transactionId: 'ledger-tx-1',
          phoneNumber: '254712345678',
          amount: { toString: () => '500' },
          conversationId: 'MWD-ledger-tx-1',
          status: TransactionStatus.PENDING,
        }),
      },
    } as unknown as PrismaService;
    const mwaloni = {
      isEnabled: jest.fn().mockReturnValue(true),
      sendMobile: jest.fn().mockRejectedValue(new MwaloniAuthException('Invalid credentials')),
    };
    const service = new MpesaService(
      mockConfig,
      prisma,
      makeRedis(1),
      mockIdempotency,
      mockDaraja,
      mockAudit,
      mockLoanRepaymentService,
      mockCallbackQueue as never,
      mockDisbursementQueue as never,
      mockB2cTimeoutQueue as never,
      mockDlqQueue as never,
      undefined,
      mwaloni as never,
      {} as never,
    );

    await expect(
      service.executeB2cDisbursement(
        'account-1',
        'FOSA_WITHDRAWAL',
        'tenant-1',
        '254712345678',
        500,
        'user-1',
        'ledger-tx-1',
      ),
    ).rejects.toMatchObject({ code: 'MWALONI_AUTH_FAILED' });

    expect(mwaloni.sendMobile).toHaveBeenCalledTimes(1);
    expect(mockDaraja.initiateB2C).not.toHaveBeenCalled();
  });
});

describe('MpesaService.getB2cWalletBalance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockAudit.create as jest.Mock).mockResolvedValue(undefined);
  });

  it('always fetches the global B2C wallet balance from Mwaloni', async () => {
    const mwaloni = {
      isEnabled: jest.fn().mockReturnValue(true),
      fetchBalance: jest.fn().mockResolvedValue({
        status: '00',
        message: 'Success',
        availableBalance: 125000,
        actualBalance: 125500,
        currency: 'KES',
      }),
    };
    const service = makeServiceWithMwaloni(mwaloni);

    const result = await service.getB2cWalletBalance('super-1', 'tenant-1');

    expect(result).toMatchObject({
      provider: 'MWALONI',
      currency: 'KES',
      balance: 125000,
      availableBalance: 125000,
      actualBalance: 125500,
      providerStatus: '00',
    });
    expect(mwaloni.fetchBalance).toHaveBeenCalledTimes(1);
    expect(mockDaraja.initiateB2C).not.toHaveBeenCalled();
    expect(mockDaraja.initiateSTKPush).not.toHaveBeenCalled();
  });

  it('fails closed when the Mwaloni B2C wallet provider is disabled', async () => {
    const mwaloni = {
      isEnabled: jest.fn().mockReturnValue(false),
      fetchBalance: jest.fn(),
    };
    const service = makeServiceWithMwaloni(mwaloni);

    await expect(service.getB2cWalletBalance('super-1', 'tenant-1')).rejects.toThrow(
      B2cProviderUnavailableException,
    );

    expect(mwaloni.fetchBalance).not.toHaveBeenCalled();
    expect(mockDaraja.initiateB2C).not.toHaveBeenCalled();
  });
});

describe('MpesaService.diagnoseMwaloniB2cAuthentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockAudit.create as jest.Mock).mockResolvedValue(undefined);
  });

  it('awaits durable audit evidence and returns only sanitized diagnostic metadata', async () => {
    const diagnostic = {
      connectionId: null,
      credentialSource: 'ENVIRONMENT_VARIABLES' as const,
      effectiveEnvironment: 'production',
      effectiveBaseUrlHost: 'wallet.mwaloni.com',
      serviceId: 'SRV-00001',
      enabled: true,
      fields: {
        serviceId: {
          present: true,
          length: 9,
          trimmedLength: 9,
          hasLeadingWhitespace: false,
          hasTrailingWhitespace: false,
        },
        username: {
          present: true,
          length: 12,
          trimmedLength: 12,
          hasLeadingWhitespace: false,
          hasTrailingWhitespace: false,
          sha256: 'username-sha256',
        },
        password: {
          present: true,
          length: 16,
          trimmedLength: 16,
          hasLeadingWhitespace: false,
          hasTrailingWhitespace: false,
        },
        apiKey: {
          present: true,
          length: 64,
          trimmedLength: 64,
          hasLeadingWhitespace: false,
          hasTrailingWhitespace: false,
          sha256: 'apikey-sha256',
        },
      },
      requestShape: {
        endpoint: 'authenticate',
        method: 'POST',
        contentType: 'application/json',
        apiKeyHeader: 'x-api-key',
        authorizationHeaderSent: false,
        bodyFields: ['username', 'password'],
        usesTokenCache: false,
      },
      authResult: {
        attempted: true,
        success: false,
        status: '01',
        message: 'Invalid credentials',
        tokenReturned: false,
        tokenType: null,
        expiresIn: null,
        httpStatus: 200,
        errorCode: 'MWALONI_AUTH_FAILED',
        retryable: false,
      },
    };
    const mwaloni = {
      diagnoseAuthentication: jest.fn().mockResolvedValue(diagnostic),
    };
    const service = makeServiceWithMwaloni(mwaloni);

    const result = await service.diagnoseMwaloniB2cAuthentication('super-1', 'tenant-1');

    expect(result).toEqual({ tenantId: 'tenant-1', ...diagnostic });
    expect(mockAudit.create).toHaveBeenCalledTimes(1);
    expect(mockAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        actorId: 'super-1',
        action: 'MPESA.B2C_WALLET.AUTH_DIAGNOSTIC',
        entityType: 'MwaloniWallet',
        entityId: 'global',
        newValue: expect.objectContaining({
          tenantId: 'tenant-1',
          effectiveBaseUrlHost: 'wallet.mwaloni.com',
          authResult: expect.objectContaining({
            status: '01',
            tokenReturned: false,
          }),
        }),
        metadata: expect.objectContaining({
          provider: 'MWALONI',
          diagnostic: 'B2C_AUTH',
          authAttempted: true,
          authSuccess: false,
          providerStatus: '01',
        }),
      }),
    );
    expect(JSON.stringify((mockAudit.create as jest.Mock).mock.calls[0][0])).not.toContain(
      'secret-provider-token',
    );
  });

  it('does not return a successful diagnostic response if audit persistence fails', async () => {
    const mwaloni = {
      diagnoseAuthentication: jest.fn().mockResolvedValue({
        connectionId: null,
        credentialSource: 'ENVIRONMENT_VARIABLES',
        effectiveEnvironment: 'production',
        effectiveBaseUrlHost: 'wallet.mwaloni.com',
        serviceId: 'SRV-00001',
        enabled: true,
        fields: {
          serviceId: {
            present: true,
            length: 9,
            trimmedLength: 9,
            hasLeadingWhitespace: false,
            hasTrailingWhitespace: false,
          },
          username: {
            present: true,
            length: 12,
            trimmedLength: 12,
            hasLeadingWhitespace: false,
            hasTrailingWhitespace: false,
            sha256: 'username-sha256',
          },
          password: {
            present: true,
            length: 16,
            trimmedLength: 16,
            hasLeadingWhitespace: false,
            hasTrailingWhitespace: false,
          },
          apiKey: {
            present: true,
            length: 64,
            trimmedLength: 64,
            hasLeadingWhitespace: false,
            hasTrailingWhitespace: false,
            sha256: 'apikey-sha256',
          },
        },
        requestShape: {
          endpoint: 'authenticate',
          method: 'POST',
          contentType: 'application/json',
          apiKeyHeader: 'x-api-key',
          authorizationHeaderSent: false,
          bodyFields: ['username', 'password'],
          usesTokenCache: false,
        },
        authResult: {
          attempted: true,
          success: true,
          status: '00',
          message: 'Success',
          tokenReturned: true,
          tokenType: 'Bearer',
          expiresIn: 3600,
          httpStatus: 200,
          errorCode: null,
          retryable: false,
        },
      }),
    };
    (mockAudit.create as jest.Mock).mockRejectedValueOnce(new Error('audit unavailable'));
    const service = makeServiceWithMwaloni(mwaloni);

    await expect(service.diagnoseMwaloniB2cAuthentication('super-1', 'tenant-1')).rejects.toThrow(
      'audit unavailable',
    );
  });
});
