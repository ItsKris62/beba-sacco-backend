import { ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { AccountStatus, AccountType, GuarantorStatus, InterestType, KycStatus, LoanStatus, UserRole } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { Decimal } from 'decimal.js';
import type { Request } from 'express';
import { LoanApplicationService } from '../loan-application.service';
import { GuarantorResponseService } from '../../../loans/guarantor-response.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AuditService } from '../../audit/audit.service';
import type { RedisService } from '../../../common/services/redis.service';
import type { IdempotencyService } from '../../../common/services/idempotency.service';
import type { GuarantorValidationService } from '../guarantor-validation.service';
import type { ProductRuleService } from '../product-rule.service';
import type { SmsService } from '../../sms/sms.service';
import type { AuditLogJobPayload, EmailJobPayload, GuarantorExpiryJobPayload, GuarantorReminderJobPayload, GuarantorValidationJobPayload } from '../../queue/queue.constants';

type QueueMock<TPayload extends object> = {
  add: jest.Mock<Promise<void>, [string, TPayload, object?]>;
};

type IdempotencyMock = {
  checkAndReserve: jest.Mock<Promise<{ status: 'NEW' | 'COMPLETED' | 'PROCESSING'; result?: unknown }>, [string, string, number]>;
  complete: jest.Mock<Promise<void>, [string, string, unknown, number]>;
  release: jest.Mock<Promise<void>, [string, string]>;
};

type SmsMock = {
  enqueueSms: jest.Mock<Promise<void>, [{ type: 'GUARANTOR_INVITE' | 'LOAN_PENDING_APPROVAL'; phone: string; message: string }, string]>;
};

type LoanApplicationPrismaMock = {
  member: { findMany: jest.Mock };
  $transaction: jest.Mock;
};

type GuarantorPrismaMock = {
  member: { findFirst: jest.Mock };
  loan: { findFirst: jest.Mock };
  user: { findMany: jest.Mock };
  $transaction: jest.Mock;
};

const tenantId = '11111111-1111-4111-8111-111111111111';
const applicantMemberId = '22222222-2222-4222-8222-222222222222';
const applicantUserId = '33333333-3333-4333-8333-333333333333';
const productId = '44444444-4444-4444-8444-444444444444';
const loanId = '55555555-5555-4555-8555-555555555555';
const guarantorOneId = '66666666-6666-4666-8666-666666666666';
const guarantorTwoId = '77777777-7777-4777-8777-777777777777';

function request(headers: Record<string, string> = {}): Request {
  return {
    ip: '197.248.10.20',
    headers: {
      'x-request-id': 'req-001',
      'user-agent': 'jest',
      ...headers,
    },
  } as unknown as Request;
}

function queue<TPayload extends object>(): QueueMock<TPayload> {
  return { add: jest.fn().mockResolvedValue(undefined) };
}

function idempotency(): IdempotencyMock {
  return {
    checkAndReserve: jest.fn().mockResolvedValue({ status: 'NEW' }),
    complete: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

function sms(): SmsMock {
  return { enqueueSms: jest.fn().mockResolvedValue(undefined) };
}

function audit(): Pick<AuditService, 'create'> {
  return { create: jest.fn().mockResolvedValue(undefined) };
}

function redis(): Pick<RedisService, 'get' | 'set' | 'del'> {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };
}

function productRules(): Pick<ProductRuleService, 'assertLoanApplicationRules'> {
  return {
    assertLoanApplicationRules: jest.fn().mockReturnValue({
      eligibleSavings: new Decimal(100000),
      savingsMultiplier: new Decimal(3),
      requiredAccountLabel: 'combined FOSA+BOSA',
      minGuarantors: 2,
      maxGuarantors: 3,
    }),
  };
}

function guarantorValidation(): Pick<
  GuarantorValidationService,
  'resolveAccountType' | 'validateGuarantorCoverage' | 'placeGuarantorHolds' | 'releaseGuarantorHolds'
> {
  return {
    resolveAccountType: jest.fn().mockReturnValue(AccountType.FOSA),
    validateGuarantorCoverage: jest.fn().mockResolvedValue({
      totalGuaranteed: new Decimal(50000),
      requiredCoverage: new Decimal(50000),
      coverageRatio: new Decimal(1),
    }),
    placeGuarantorHolds: jest.fn().mockResolvedValue(undefined),
    releaseGuarantorHolds: jest.fn().mockResolvedValue(undefined),
  };
}

function buildLoanApplicationService(args: {
  prisma: LoanApplicationPrismaMock;
  smsService: SmsMock;
  idempotencyService?: IdempotencyMock;
}) {
  return {
    service: new LoanApplicationService(
      args.prisma as unknown as PrismaService,
      audit() as AuditService,
      redis() as RedisService,
      (args.idempotencyService ?? idempotency()) as unknown as IdempotencyService,
      guarantorValidation() as GuarantorValidationService,
      productRules() as ProductRuleService,
      queue<GuarantorReminderJobPayload>() as never,
      queue<GuarantorExpiryJobPayload>() as never,
      queue<GuarantorValidationJobPayload>() as never,
      queue<EmailJobPayload>() as never,
      queue<AuditLogJobPayload>() as never,
      args.smsService as unknown as SmsService,
    ),
  };
}

function createSuccessfulLoanApplyPrisma(): LoanApplicationPrismaMock {
  const tx = {
    member: {
      findFirst: jest
        .fn()
        .mockResolvedValueOnce({ id: applicantMemberId, memberNumber: 'M-001', kycStatus: KycStatus.APPROVED })
        .mockResolvedValue({ id: guarantorOneId, kycStatus: KycStatus.APPROVED, user: { role: UserRole.MEMBER, accountStatus: AccountStatus.ACTIVE } }),
    },
    loan: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: loanId,
        tenantId,
        memberId: applicantMemberId,
        loanProductId: productId,
        loanNumber: 'LN-2026-000001',
        status: LoanStatus.PENDING_GUARANTORS,
        principalAmount: new Decimal(50000),
        member: { memberNumber: 'M-001', user: { firstName: 'Amina', lastName: 'Otieno' } },
        loanProduct: { name: 'Development', interestType: InterestType.REDUCING_BALANCE },
      }),
    },
    loanProduct: {
      findFirst: jest.fn().mockResolvedValue({
        id: productId,
        name: 'Development',
        minAmount: new Decimal(1000),
        maxAmount: new Decimal(200000),
        interestRate: new Decimal('0.12'),
        interestType: InterestType.REDUCING_BALANCE,
        processingFeeRate: new Decimal('0.01'),
        maxTenureMonths: 24,
        gracePeriodMonths: 0,
        minGuarantors: 2,
        maxGuarantors: 3,
        guarantorCoverageRatio: new Decimal(1),
        requiredAccountType: AccountType.FOSA,
        savingsMultiplier: new Decimal(3),
      }),
    },
    account: {
      findMany: jest.fn().mockResolvedValue([{ accountType: AccountType.FOSA, balance: new Decimal(100000), lockedBalance: new Decimal(0) }]),
      findFirst: jest.fn().mockResolvedValue({ id: 'account-1', balance: new Decimal(100000), lockedBalance: new Decimal(0) }),
    },
    loanGuarantor: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockResolvedValueOnce({ id: 'lg-1', memberId: guarantorOneId })
        .mockResolvedValueOnce({ id: 'lg-2', memberId: guarantorTwoId }),
    },
    tenant: { findFirst: jest.fn().mockResolvedValue(null) },
    tenantCounter: { upsert: jest.fn().mockResolvedValue({ loanSeq: 1 }) },
    auditLog: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    $queryRaw: jest.fn().mockResolvedValue([{ id: applicantMemberId }]),
  };

  return {
    member: {
      findMany: jest.fn().mockResolvedValue([
        { id: guarantorOneId, user: { email: 'g1@example.test', firstName: 'Grace', phone: '0711111111', phoneNumber: null } },
        { id: guarantorTwoId, user: { email: 'g2@example.test', firstName: 'Brian', phone: '0722222222', phoneNumber: null } },
      ]),
    },
    $transaction: jest.fn((callback: (transactionClient: typeof tx) => Promise<unknown>) => callback(tx)),
  };
}

describe('LoanApplicationService member loan workflow', () => {
  it('creates a loan with guarantors atomically and enqueues SMS for each guarantor', async () => {
    const prisma = createSuccessfulLoanApplyPrisma();
    const smsService = sms();
    const { service } = buildLoanApplicationService({ prisma, smsService });

    const result = await service.memberApply(
      {
        loanProductId: productId,
        principalAmount: 50000,
        tenureMonths: 12,
        purpose: 'School fees',
        guarantors: [
          { memberId: guarantorOneId, guaranteedAmount: 25000 },
          { memberId: guarantorTwoId, guaranteedAmount: 25000 },
        ],
      },
      tenantId,
      applicantMemberId,
      applicantUserId,
      request(),
      'apply-key-001',
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(LoanStatus.PENDING_GUARANTORS);
    expect(smsService.enqueueSms).toHaveBeenCalledTimes(2);
    expect(smsService.enqueueSms).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'GUARANTOR_INVITE', phone: '0711111111' }),
      `loan.apply.guarantorSms:${loanId}:${guarantorOneId}`,
    );
  });

  it('wraps unexpected Prisma transaction errors and does not enqueue SMS', async () => {
    const prisma: LoanApplicationPrismaMock = {
      member: { findMany: jest.fn() },
      $transaction: jest.fn().mockRejectedValue(
        new PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      ),
    };
    const smsService = sms();
    const { service } = buildLoanApplicationService({ prisma, smsService });

    await expect(
      service.memberApply(
        {
          loanProductId: productId,
          principalAmount: 50000,
          tenureMonths: 12,
          purpose: 'Business',
          guarantors: [{ memberId: guarantorOneId, guaranteedAmount: 50000 }],
        },
        tenantId,
        applicantMemberId,
        applicantUserId,
        request(),
        'apply-key-rollback',
      ),
    ).rejects.toThrow(InternalServerErrorException);

    expect(smsService.enqueueSms).not.toHaveBeenCalled();
  });
});

function buildGuarantorService(args: {
  prisma: GuarantorPrismaMock;
  smsService: SmsMock;
  idempotencyService?: IdempotencyMock;
  validationService?: Pick<GuarantorValidationService, 'placeGuarantorHolds' | 'releaseGuarantorHolds'>;
}): GuarantorResponseService {
  return new GuarantorResponseService(
    args.prisma as unknown as PrismaService,
    (args.validationService ?? guarantorValidation()) as GuarantorValidationService,
    (args.idempotencyService ?? idempotency()) as unknown as IdempotencyService,
    args.smsService as unknown as SmsService,
  );
}

function createLastGuarantorAcceptPrisma(): GuarantorPrismaMock {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([
      {
        id: 'lg-2',
        status: GuarantorStatus.PENDING,
        invitedAt: new Date(),
        guaranteedAmount: '25000',
        memberId: guarantorTwoId,
      },
    ]),
    member: { findFirst: jest.fn().mockResolvedValue({ id: guarantorTwoId, kycStatus: KycStatus.APPROVED }) },
    loan: {
      findFirst: jest.fn().mockResolvedValue({
        id: loanId,
        status: LoanStatus.PENDING_GUARANTORS,
        principalAmount: new Decimal(50000),
        loanProduct: { minGuarantors: 2, guarantorCoverageRatio: new Decimal(1), requiredAccountType: AccountType.FOSA },
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    loanGuarantor: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([
        { id: 'lg-1', memberId: guarantorOneId, status: GuarantorStatus.ACCEPTED, guaranteedAmount: new Decimal(25000), holdReleasedAt: null },
        { id: 'lg-2', memberId: guarantorTwoId, status: GuarantorStatus.ACCEPTED, guaranteedAmount: new Decimal(25000), holdReleasedAt: null },
      ]),
    },
    auditLog: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'audit-2' }) },
  };

  return {
    member: { findFirst: jest.fn().mockResolvedValue({ id: guarantorTwoId }) },
    loan: { findFirst: jest.fn().mockResolvedValue({ loanNumber: 'LN-2026-000001' }) },
    user: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'officer-user-1', phone: '0733333333', phoneNumber: null },
      ]),
    },
    $transaction: jest.fn((callback: (transactionClient: typeof tx) => Promise<unknown>) => callback(tx)),
  };
}

describe('GuarantorResponseService respondAsMember', () => {
  it('advances the loan to PENDING_APPROVAL when the last required guarantor accepts', async () => {
    const prisma = createLastGuarantorAcceptPrisma();
    const smsService = sms();
    const service = buildGuarantorService({ prisma, smsService });

    const result = await service.respondAsMember(
      loanId,
      guarantorTwoId,
      { action: 'ACCEPT' },
      tenantId,
      'guarantor-user-2',
      request({ 'x-idempotency-key': 'guarantor-key-2' }),
      'guarantor-key-2',
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect((result as { loanStatus: LoanStatus }).loanStatus).toBe(LoanStatus.PENDING_APPROVAL);
    expect(smsService.enqueueSms).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'LOAN_PENDING_APPROVAL', phone: '0733333333' }),
      `loan.pendingApprovalSms:${loanId}:officer-user-1`,
    );
  });

  it('throws ForbiddenException when the authenticated user does not own the guarantor member record', async () => {
    const prisma: GuarantorPrismaMock = {
      member: { findFirst: jest.fn().mockResolvedValue(null) },
      loan: { findFirst: jest.fn() },
      user: { findMany: jest.fn() },
      $transaction: jest.fn(),
    };
    const service = buildGuarantorService({ prisma, smsService: sms() });

    await expect(
      service.respondAsMember(
        loanId,
        guarantorOneId,
        { action: 'ACCEPT' },
        tenantId,
        'attacker-user-id',
        request({ 'x-idempotency-key': 'idor-key' }),
        'idor-key',
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
