import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AccountStatus, AccountType, LoanStatus, GuarantorStatus, UserRole, InterestType } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { LoanApplicationService } from './loan-application.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RedisService } from '../../common/services/redis.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { getQueueToken } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { GuarantorValidationService } from './guarantor-validation.service';
import { ProductRuleService } from './product-rule.service';
import { SmsService } from '../sms/sms.service';
import { LoansService } from './loans.service';

/**
 * LoanApplicationService Unit Tests
 *
 * Covers: eligibility, consent spoofing, expiry, idempotency, guarantee caps,
 * audit event publishing, and role-based access control.
 */
describe('LoanApplicationService', () => {
  let service: LoanApplicationService;
  let prisma: any;

  const createMockPrisma = (): any => ({
    member: { findFirst: jest.fn(), count: jest.fn() },
    loan: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
    loanProduct: { findFirst: jest.fn() },
    account: { findMany: jest.fn(), findFirst: jest.fn() },
    tenant: { findFirst: jest.fn().mockResolvedValue({ settings: {} }) },
    loanGuarantor: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    tenantCounter: { upsert: jest.fn() },
    auditLog: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn((cb: (tx: any) => unknown) => cb(createMockPrisma())),
  });

  const mockAudit = { create: jest.fn().mockResolvedValue(undefined) };
  const mockRedis = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
  const mockIdempotency = {
    checkAndReserve: jest.fn().mockResolvedValue({ status: 'NEW' }),
    complete: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const mockQueue = { add: jest.fn().mockResolvedValue(undefined) };
  const mockGuarantorValidation = {
    resolveAccountType: jest.fn().mockReturnValue('FOSA'),
    validateGuarantorCoverage: jest.fn().mockResolvedValue({
      totalGuaranteed: new Decimal(1000),
      requiredCoverage: new Decimal(1000),
      coverageRatio: new Decimal(1),
    }),
    placeGuarantorHolds: jest.fn().mockResolvedValue(undefined),
    releaseGuarantorHolds: jest.fn().mockResolvedValue(undefined),
  };
  const mockProductRules = {
    assertLoanApplicationRules: jest.fn().mockReturnValue({
      eligibleSavings: new Decimal(100000),
      savingsMultiplier: new Decimal(3),
      requiredAccountLabel: 'FOSA',
      minGuarantors: 0,
      maxGuarantors: 3,
    }),
  };
  const mockSms = { enqueueSms: jest.fn().mockResolvedValue(undefined) };
  const mockLoansService = {
    approve: jest.fn(),
    reject: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoanApplicationService,
        { provide: PrismaService, useValue: createMockPrisma() },
        { provide: AuditService, useValue: mockAudit },
        { provide: RedisService, useValue: mockRedis },
        { provide: IdempotencyService, useValue: mockIdempotency },
        { provide: GuarantorValidationService, useValue: mockGuarantorValidation },
        { provide: ProductRuleService, useValue: mockProductRules },
        { provide: getQueueToken(QUEUE_NAMES.LOAN_GUARANTOR_REMINDER), useValue: mockQueue },
        { provide: getQueueToken(QUEUE_NAMES.LOAN_GUARANTOR_EXPIRY), useValue: mockQueue },
        { provide: getQueueToken(QUEUE_NAMES.GUARANTOR_VALIDATION), useValue: mockQueue },
        { provide: getQueueToken(QUEUE_NAMES.EMAIL), useValue: mockQueue },
        { provide: getQueueToken(QUEUE_NAMES.AUDIT_LOG), useValue: mockQueue },
        { provide: SmsService, useValue: mockSms },
        { provide: LoansService, useValue: mockLoansService },
      ],
    }).compile();

    service = module.get(LoanApplicationService);
    prisma = module.get(PrismaService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── MEMBER ELIGIBILITY ───────────────────────────────────────────────────

  describe('validateMemberEligibility', () => {
    it('should reject if KYC is not APPROVED', async () => {
      prisma.member.findFirst.mockResolvedValue({ id: 'm1', memberNumber: 'M1', kycStatus: 'PENDING_REVIEW', user: { firstName: 'J', lastName: 'D' } } as any);
      prisma.account.findMany.mockResolvedValue([]);

      const result = await service.validateMemberEligibility('m1', 't1');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('KYC');
    });

    it('should reject if no active FOSA or BOSA account', async () => {
      prisma.member.findFirst.mockResolvedValue({ id: 'm1', memberNumber: 'M1', kycStatus: 'APPROVED', user: { firstName: 'J', lastName: 'D' } } as any);
      prisma.account.findMany.mockResolvedValue([]);

      const result = await service.validateMemberEligibility('m1', 't1');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('No active FOSA or BOSA');
    });

    it('should reject if member has defaulted loan', async () => {
      prisma.member.findFirst.mockResolvedValue({ id: 'm1', memberNumber: 'M1', kycStatus: 'APPROVED', user: { firstName: 'J', lastName: 'D' } } as any);
      prisma.account.findMany.mockResolvedValue([{ accountType: 'FOSA', balance: '10000' }] as any);
      prisma.loan.findFirst.mockResolvedValue({ id: 'l1' } as any);

      const result = await service.validateMemberEligibility('m1', 't1');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('defaulted loan');
    });

    it('should approve eligible member', async () => {
      prisma.member.findFirst.mockResolvedValue({ id: 'm1', memberNumber: 'M1', kycStatus: 'APPROVED', user: { firstName: 'J', lastName: 'D' } } as any);
      prisma.account.findMany.mockResolvedValue([{ accountType: 'FOSA', balance: '50000' }, { accountType: 'BOSA', balance: '30000' }] as any);
      prisma.loan.findFirst.mockResolvedValue(null);

      const result = await service.validateMemberEligibility('m1', 't1');
      expect(result.eligible).toBe(true);
      expect(result.fosaBalance.toNumber()).toBe(50000);
      expect(result.bosaBalance.toNumber()).toBe(30000);
    });
  });

  // ─── GUARANTOR ELIGIBILITY ────────────────────────────────────────────────

  describe('validateGuarantorEligibility', () => {
    it('should reject self-guarantee', async () => {
      const result = await service.validateGuarantorEligibility('m1', 'l1', 't1', new Decimal(1000), 'm1');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('own loan');
    });

    it('should reject if no FOSA account', async () => {
      prisma.member.findFirst.mockResolvedValue({
        id: 'g1',
        kycStatus: 'APPROVED',
        isBlacklisted: false,
        user: { firstName: 'J', role: UserRole.MEMBER, accountStatus: AccountStatus.ACTIVE },
      } as any);
      prisma.account.findFirst.mockResolvedValue(null);

      const result = await service.validateGuarantorEligibility('g1', 'l1', 't1', new Decimal(1000), 'm1');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('no active FOSA');
    });

    it('should reject if FOSA balance < guaranteed amount', async () => {
      prisma.member.findFirst.mockResolvedValue({
        id: 'g1',
        kycStatus: 'APPROVED',
        isBlacklisted: false,
        user: { firstName: 'J', role: UserRole.MEMBER, accountStatus: AccountStatus.ACTIVE },
      } as any);
      prisma.account.findFirst.mockResolvedValue({ id: 'a1', balance: '500', lockedBalance: '0' } as any);

      const result = await service.validateGuarantorEligibility('g1', 'l1', 't1', new Decimal(1000), 'm1');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('Insufficient FOSA');
    });

    it('rejects a BOSA-required guarantee when the guarantor has sufficient FOSA but insufficient BOSA balance', async () => {
      prisma.member.findFirst.mockResolvedValue({
        id: 'g1',
        kycStatus: 'APPROVED',
        isBlacklisted: false,
        user: { firstName: 'J', role: UserRole.MEMBER, accountStatus: AccountStatus.ACTIVE },
      } as any);
      prisma.account.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.accountType === AccountType.BOSA
            ? { id: 'bosa-1', balance: '500', lockedBalance: '0' }
            : { id: 'fosa-1', balance: '50000', lockedBalance: '0' },
        ),
      );

      const result = await service.validateGuarantorEligibility(
        'g1', 'l1', 't1', new Decimal(1000), 'm1', AccountType.BOSA,
      );
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('Insufficient FOSA');
      expect(prisma.account.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ accountType: AccountType.BOSA }) }),
      );
    });

    it('accepts a BOSA-required guarantee when the guarantor has sufficient BOSA but insufficient FOSA balance', async () => {
      prisma.member.findFirst.mockResolvedValue({
        id: 'g1',
        kycStatus: 'APPROVED',
        isBlacklisted: false,
        user: { firstName: 'J', role: UserRole.MEMBER, accountStatus: AccountStatus.ACTIVE },
      } as any);
      prisma.account.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.accountType === AccountType.BOSA
            ? { id: 'bosa-1', balance: '50000', lockedBalance: '0' }
            : { id: 'fosa-1', balance: '500', lockedBalance: '0' },
        ),
      );
      prisma.loan.findFirst.mockResolvedValue(null);
      prisma.loanGuarantor.count.mockResolvedValue(0);

      const result = await service.validateGuarantorEligibility(
        'g1', 'l1', 't1', new Decimal(1000), 'm1', AccountType.BOSA,
      );
      expect(result.eligible).toBe(true);
      expect(prisma.account.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ accountType: AccountType.BOSA }) }),
      );
    });

    it('should reject if max concurrent guarantees exceeded', async () => {
      prisma.member.findFirst.mockResolvedValue({
        id: 'g1',
        kycStatus: 'APPROVED',
        isBlacklisted: false,
        user: { firstName: 'J', role: UserRole.MEMBER, accountStatus: AccountStatus.ACTIVE },
      } as any);
      prisma.account.findFirst.mockResolvedValue({ id: 'a1', balance: '50000', lockedBalance: '0' } as any);
      prisma.loan.findFirst.mockResolvedValue(null);
      prisma.loanGuarantor.count.mockResolvedValue(3);

      const result = await service.validateGuarantorEligibility('g1', 'l1', 't1', new Decimal(1000), 'm1');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('maximum concurrent guarantee limit');
    });

    it('should reject blacklisted guarantor', async () => {
      prisma.member.findFirst.mockResolvedValue({
        id: 'g1',
        kycStatus: 'APPROVED',
        isBlacklisted: true,
        user: { firstName: 'J', role: UserRole.MEMBER, accountStatus: AccountStatus.ACTIVE },
      } as any);

      const result = await service.validateGuarantorEligibility('g1', 'l1', 't1', new Decimal(1000), 'm1');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('blacklisted');
      expect(prisma.loanGuarantor.count).not.toHaveBeenCalled();
    });
  });

  describe('blacklist enforcement', () => {
    const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test', 'x-request-id': 'req-1' } } as any;

    it('throws ForbiddenException and does not create a loan for a blacklisted applicant', async () => {
      const tx = createMockPrisma();
      tx.member.findFirst.mockResolvedValue({
        id: 'm1',
        memberNumber: 'M1',
        kycStatus: 'APPROVED',
        isBlacklisted: true,
      });
      prisma.$transaction.mockImplementation((cb: (transactionClient: any) => unknown) => cb(tx));

      await expect(
        service.memberApply(
          { loanProductId: 'p1', principalAmount: 10000, tenureMonths: 6, purpose: 'Emergency' },
          't1',
          'm1',
          'u1',
          mockReq,
          'idem-blacklisted-applicant',
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(tx.loan.create).not.toHaveBeenCalled();
    });

    it('throws before creating guarantor rows for a blacklisted nominated guarantor', async () => {
      const tx = createMockPrisma();
      tx.member.findFirst
        .mockResolvedValueOnce({
          id: 'm1',
          memberNumber: 'M1',
          kycStatus: 'APPROVED',
          isBlacklisted: false,
        })
        .mockResolvedValueOnce({
          id: 'g1',
          kycStatus: 'APPROVED',
          isBlacklisted: true,
          user: { role: UserRole.MEMBER, accountStatus: AccountStatus.ACTIVE },
        });
      tx.loan.findFirst.mockResolvedValue(null);
      tx.loanProduct.findFirst.mockResolvedValue({
        id: 'p1',
        name: 'Development',
        minAmount: '1000',
        maxAmount: '50000',
        maxTenureMonths: 12,
        interestRate: '0.12',
        interestType: InterestType.FLAT,
        processingFeeRate: '0.01',
        gracePeriodMonths: 0,
        requiredAccountType: 'FOSA',
        guarantorCoverageRatio: '1',
        minGuarantors: 1,
        maxGuarantors: 3,
      });
      tx.account.findMany.mockResolvedValue([{ accountType: 'FOSA', balance: '50000', lockedBalance: '0' }]);
      prisma.$transaction.mockImplementation((cb: (transactionClient: any) => unknown) => cb(tx));

      await expect(
        service.memberApply(
          {
            loanProductId: 'p1',
            principalAmount: 10000,
            tenureMonths: 6,
            purpose: 'Business',
            guarantors: [{ memberId: 'g1', guaranteedAmount: 10000 }],
          },
          't1',
          'm1',
          'u1',
          mockReq,
          'idem-blacklisted-guarantor',
        ),
      ).rejects.toThrow(BadRequestException);

      expect(tx.loan.create).not.toHaveBeenCalled();
      expect(tx.loanGuarantor.create).not.toHaveBeenCalled();
    });

    it('should reject guarantor if circular guarantee is detected', async () => {
      const tx = createMockPrisma();
      tx.member.findFirst
        .mockResolvedValueOnce({
          id: 'applicant-a',
          memberNumber: 'M1',
          kycStatus: 'APPROVED',
          isBlacklisted: false,
        })
        .mockResolvedValueOnce({
          id: 'guarantor-b',
          kycStatus: 'APPROVED',
          isBlacklisted: false,
          user: { role: UserRole.MEMBER, accountStatus: AccountStatus.ACTIVE },
        });
      tx.loan.findFirst.mockResolvedValue(null);
      tx.loanProduct.findFirst.mockResolvedValue({
        id: 'p1',
        name: 'Development',
        minAmount: '1000',
        maxAmount: '50000',
        maxTenureMonths: 12,
        interestRate: '0.12',
        interestType: InterestType.FLAT,
        processingFeeRate: '0.01',
        gracePeriodMonths: 0,
        requiredAccountType: 'FOSA',
        guarantorCoverageRatio: '1',
        minGuarantors: 1,
        maxGuarantors: 3,
      });
      tx.account.findMany.mockResolvedValue([{ accountType: 'FOSA', balance: '50000', lockedBalance: '0' }]);
      tx.loanGuarantor.findFirst.mockResolvedValue({ id: 'existing-reverse-guarantee' });
      prisma.$transaction.mockImplementation((cb: (transactionClient: any) => unknown) => cb(tx));

      await expect(
        service.memberApply(
          {
            loanProductId: 'p1',
            principalAmount: 10000,
            tenureMonths: 6,
            purpose: 'Business',
            guarantors: [{ memberId: 'guarantor-b', guaranteedAmount: 10000 }],
          },
          't1',
          'applicant-a',
          'u1',
          mockReq,
          'idem-circular-guarantor',
        ),
      ).rejects.toThrow(BadRequestException);

      expect(tx.loanGuarantor.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            memberId: 'applicant-a',
            loan: expect.objectContaining({ memberId: 'guarantor-b' }),
          }),
        }),
      );
      expect(tx.loan.create).not.toHaveBeenCalled();
      expect(tx.loanGuarantor.create).not.toHaveBeenCalled();
    });
  });

  // ─── STATUS UPDATE (RBAC) ─────────────────────────────────────────────────

  describe('updateStatus', () => {
    const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test', 'x-request-id': 'req-1' } } as any;

    it('should reject unauthorized role', async () => {
      prisma.loan.findFirst.mockResolvedValue({ id: 'l1', status: LoanStatus.DRAFT, loanNumber: 'LN-1', memberId: 'm1' } as any);

      await expect(
        service.updateStatus('l1', { status: 'APPROVED' as any }, 't1', { id: 'u1', role: UserRole.MEMBER, tenantId: 't1' } as any, mockReq),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject invalid state transition', async () => {
      prisma.loan.findFirst.mockResolvedValue({ id: 'l1', status: LoanStatus.DRAFT, loanNumber: 'LN-1', memberId: 'm1' } as any);

      await expect(
        service.updateStatus('l1', { status: 'APPROVED' as any }, 't1', { id: 'u1', role: UserRole.MANAGER, tenantId: 't1' } as any, mockReq),
      ).rejects.toThrow(BadRequestException);
    });

    it('should require reason for rejection', async () => {
      prisma.loan.findFirst.mockResolvedValue({ id: 'l1', status: LoanStatus.PENDING_REVIEW, loanNumber: 'LN-1', memberId: 'm1' } as any);

      await expect(
        service.updateStatus('l1', { status: 'REJECTED' as any }, 't1', { id: 'u1', role: UserRole.MANAGER, tenantId: 't1' } as any, mockReq),
      ).rejects.toThrow(BadRequestException);
    });

    it('delegates APPROVED to LoansService.approve without a bare loan update', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        id: 'l1',
        status: LoanStatus.PENDING_REVIEW,
        loanNumber: 'LN-1',
        memberId: 'm1',
      } as any);
      mockLoansService.approve.mockResolvedValueOnce({ id: 'l1', status: LoanStatus.APPROVED });

      await service.updateStatus(
        'l1',
        { status: 'APPROVED' as any, reason: 'Credit committee approved' },
        't1',
        { id: 'u1', role: UserRole.MANAGER, tenantId: 't1' } as any,
        mockReq,
      );

      expect(mockLoansService.approve).toHaveBeenCalledWith(
        'l1',
        't1',
        'u1',
        'Credit committee approved',
        '127.0.0.1',
        'test',
      );
      expect(prisma.loan.update).not.toHaveBeenCalled();
    });

    it('delegates REJECTED to LoansService.reject without a bare loan update', async () => {
      prisma.loan.findFirst.mockResolvedValue({
        id: 'l1',
        status: LoanStatus.PENDING_REVIEW,
        loanNumber: 'LN-1',
        memberId: 'm1',
      } as any);
      mockLoansService.reject.mockResolvedValueOnce({ id: 'l1', status: LoanStatus.REJECTED });

      await service.updateStatus(
        'l1',
        { status: 'REJECTED' as any, reason: 'Insufficient guarantor coverage' },
        't1',
        { id: 'u1', role: UserRole.MANAGER, tenantId: 't1' } as any,
        mockReq,
      );

      expect(mockLoansService.reject).toHaveBeenCalledWith(
        'l1',
        { reason: 'Insufficient guarantor coverage' },
        't1',
        'u1',
        '127.0.0.1',
        'test',
      );
      expect(prisma.loan.update).not.toHaveBeenCalled();
    });
  });
});
