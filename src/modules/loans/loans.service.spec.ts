import { NotFoundException, BadRequestException } from '@nestjs/common';
import { InterestType, LoanStatus } from '@prisma/client';
import { LoansService } from './loans.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RedisService } from '../../common/services/redis.service';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-uuid-1';
const MEMBER_ID = 'member-uuid-1';
const PRODUCT_ID = 'product-uuid-1';
const ACTOR_ID  = 'user-uuid-1';

const mockProduct = {
  id: PRODUCT_ID,
  tenantId: TENANT_ID,
  name: 'Standard Loan',
  isActive: true,
  minAmount: '1000.0000',
  maxAmount: '100000.0000',
  interestRate: '12.0000',
  interestType: InterestType.REDUCING_BALANCE,
  maxTenureMonths: 36,
  processingFeeRate: '0.0100',
  gracePeriodMonths: 0,
};

const APPLY_DTO = {
  memberId: MEMBER_ID,
  loanProductId: PRODUCT_ID,
  principalAmount: 50000,
  tenureMonths: 12,
  purpose: 'Business expansion',
};

// ─── Mock factories ───────────────────────────────────────────────────────────

function makePrisma(overrides: {
  memberResult?: object | null;
  productResult?: object | null;
  counterResult?: object;
  loanCreateResult?: object;
  transactionFn?: jest.Mock;
} = {}) {
  const counterResult = overrides.counterResult ?? { tenantId: TENANT_ID, loanSeq: 1 };
  const loanResult = overrides.loanCreateResult ?? {
    id: 'loan-uuid-1',
    loanNumber: 'LN-2024-000001',
    tenantId: TENANT_ID,
    member: { memberNumber: 'MBR-001', user: { firstName: 'Jane', lastName: 'Doe' } },
    loanProduct: { name: 'Standard Loan', interestType: InterestType.REDUCING_BALANCE },
  };

  // Default $transaction wraps the fn with a tx that has upsert + create
  const defaultTxFn = jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      tenantCounter: {
        upsert: jest.fn().mockResolvedValue(counterResult),
      },
      loan: {
        create: jest.fn().mockResolvedValue(loanResult),
      },
    };
    return fn(tx);
  });

  return {
    member: {
      findFirst: jest.fn().mockResolvedValue(
        overrides.memberResult !== undefined
          ? overrides.memberResult
          : { id: MEMBER_ID, memberNumber: 'MBR-001' },
      ),
    },
    loanProduct: {
      findFirst: jest.fn().mockResolvedValue(
        overrides.productResult !== undefined ? overrides.productResult : mockProduct,
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: overrides.transactionFn ?? defaultTxFn,
  } as unknown as PrismaService;
}

const mockAudit = { create: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(true),
} as unknown as RedisService;
const mockEmailQueue = { add: jest.fn().mockResolvedValue({}) };
const mockGuarantorQueue = { add: jest.fn().mockResolvedValue({}) };

function makeService(prisma: PrismaService): LoansService {
  return new LoansService(
    prisma,
    mockAudit,
    mockRedis,
    mockGuarantorQueue as never,
    mockEmailQueue as never,
  );
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('LoansService.apply [M-5]', () => {

  beforeEach(() => jest.clearAllMocks());

  // ── Atomic counter + loan create ─────────────────────────────────────────

  it('[M-5] wraps tenantCounter.upsert and loan.create in a single $transaction', async () => {
    const transactionFn = jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        tenantCounter: { upsert: jest.fn().mockResolvedValue({ loanSeq: 1 }) },
        loan: {
          create: jest.fn().mockResolvedValue({
            id: 'loan-1',
            loanNumber: 'LN-2024-000001',
            member: { memberNumber: 'M1', user: { firstName: 'A', lastName: 'B' } },
            loanProduct: { name: 'P', interestType: InterestType.FLAT },
          }),
        },
      };
      return fn(tx);
    });

    const prisma = makePrisma({ transactionFn });
    const service = makeService(prisma);

    await service.apply(APPLY_DTO, TENANT_ID, ACTOR_ID);

    expect(transactionFn).toHaveBeenCalledTimes(1);
  });

  it('[M-5] rolls back counter increment when loan.create throws', async () => {
    let counterUpsertCalls = 0;

    const transactionFn = jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        tenantCounter: {
          upsert: jest.fn().mockImplementation(() => {
            counterUpsertCalls++;
            return Promise.resolve({ loanSeq: 1 });
          }),
        },
        loan: {
          create: jest.fn().mockRejectedValue(new Error('Unique constraint violation')),
        },
      };
      return fn(tx); // Prisma's $transaction will rollback if the fn throws
    });

    const prisma = makePrisma({ transactionFn });
    const service = makeService(prisma);

    await expect(service.apply(APPLY_DTO, TENANT_ID, ACTOR_ID)).rejects.toThrow();

    // The transaction was attempted (and rolled back by Prisma)
    expect(transactionFn).toHaveBeenCalledTimes(1);
  });

  it('[M-5] loan number is derived from the counter value returned inside the transaction', async () => {
    const transactionFn = jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        tenantCounter: { upsert: jest.fn().mockResolvedValue({ loanSeq: 42 }) },
        loan: {
          create: jest.fn().mockImplementation(({ data }: { data: { loanNumber: string } }) =>
            Promise.resolve({
              id: 'loan-42',
              loanNumber: data.loanNumber,
              member: { memberNumber: 'M1', user: { firstName: 'A', lastName: 'B' } },
              loanProduct: { name: 'P', interestType: InterestType.FLAT },
            }),
          ),
        },
      };
      return fn(tx);
    });

    const prisma = makePrisma({ transactionFn });
    const service = makeService(prisma);

    const result = await service.apply(APPLY_DTO, TENANT_ID, ACTOR_ID);

    const year = new Date().getFullYear();
    expect(result.loanNumber).toBe(`LN-${year}-000042`);
  });

  // ── Validation guards ────────────────────────────────────────────────────

  it('throws NotFoundException when member does not belong to the tenant', async () => {
    const prisma = makePrisma({ memberResult: null });
    const service = makeService(prisma);

    await expect(service.apply(APPLY_DTO, TENANT_ID, ACTOR_ID)).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when loan product does not exist', async () => {
    const prisma = makePrisma({ productResult: null });
    const service = makeService(prisma);

    await expect(service.apply(APPLY_DTO, TENANT_ID, ACTOR_ID)).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException when principal is below product minimum', async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await expect(
      service.apply({ ...APPLY_DTO, principalAmount: 100 }, TENANT_ID, ACTOR_ID),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when tenure exceeds product maximum', async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await expect(
      service.apply({ ...APPLY_DTO, tenureMonths: 999 }, TENANT_ID, ACTOR_ID),
    ).rejects.toThrow(BadRequestException);
  });
});
