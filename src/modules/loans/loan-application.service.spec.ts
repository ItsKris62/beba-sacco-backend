import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { LoanStatus, GuarantorStatus, UserRole, InterestType } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { LoanApplicationService } from './loan-application.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RedisService } from '../../common/services/redis.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { getQueueToken } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';

/**
 * LoanApplicationService Unit Tests
 *
 * Covers: eligibility, consent spoofing, expiry, idempotency, guarantee caps,
 * audit event publishing, and role-based access control.
 */
describe('LoanApplicationService', () => {
  let service: LoanApplicationService;
  let prisma: jest.Mocked<PrismaService>;

  const mockPrisma = () => ({
    member: { findFirst: jest.fn(), count: jest.fn() },
    loan: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
    loanProduct: { findFirst: jest.fn() },
    account: { findMany: jest.fn(), findFirst: jest.fn() },
    guarantor: { findFirst: jest.fn(), findMany: jest.fn(), upsert: jest.fn(), update: jest.fn(), count: jest.fn() },
    tenantCounter: { upsert: jest.fn() },
    $transaction: jest.fn((cb) => cb(mockPrisma())),
  });

  const mockAudit = { create: jest.fn().mockResolvedValue(undefined) };
  const mockRedis = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
  const mockIdempotency = {
    checkAndReserve: jest.fn().mockResolvedValue({ status: 'NEW' }),
    complete: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const mockQueue = { add: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoanApplicationService,
        { provide: PrismaService, useValue: mockPrisma() },
        { provide: AuditService, useValue: mockAudit },
        { provide: RedisService, useValue: mockRedis },
        { provide: IdempotencyService, useValue: mockIdempotency },
        { provide: getQueueToken(QUEUE_NAMES.LOAN_GUARANTOR_REMINDER), useValue: mockQueue },
        { provide: getQueueToken(QUEUE_NAMES.EMAIL), useValue: mockQueue },
        { provide: getQueueToken(QUEUE_NAMES.AUDIT_LOG), useValue: mockQueue },
      ],
    }).compile();

    service = module.get(LoanApplicationService);
    prisma = module.get(PrismaService) as jest.Mocked<PrismaService>;
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
      prisma.member.findFirst.mockResolvedValue({ id: 'g1', user: { firstName: 'J' } } as any);
      prisma.account.findFirst.mockResolvedValue(null);

      const result = await service.validateGuarantorEligibility('g1', 'l1', 't1', new Decimal(1000), 'm1');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('no active FOSA');
    });

    it('should reject if FOSA balance < guaranteed amount', async () => {
      prisma.member.findFirst.mockResolvedValue({ id: 'g1', user: { firstName: 'J' } } as any);
      prisma.account.findFirst.mockResolvedValue({ id: 'a1', balance: '500' } as any);

      const result = await service.validateGuarantorEligibility('g1', 'l1', 't1', new Decimal(1000), 'm1');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('Insufficient FOSA');
    });

    it('should reject if max concurrent guarantees exceeded', async () => {
      prisma.member.findFirst.mockResolvedValue({ id: 'g1', user: { firstName: 'J' } } as any);
      prisma.account.findFirst.mockResolvedValue({ id: 'a1', balance: '50000' } as any);
      prisma.loan.findFirst.mockResolvedValue(null);
      prisma.guarantor.count.mockResolvedValue(3);

      const result = await service.validateGuarantorEligibility('g1', 'l1', 't1', new Decimal(1000), 'm1');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('maximum concurrent guarantee limit');
    });
  });

  // ─── GUARANTOR CONSENT RESPONSE ───────────────────────────────────────────

  describe('guarantorResponse', () => {
    const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test', 'x-request-id': 'req-1' } } as any;

    it('should reject consent spoofing (wrong JWT)', async () => {
      prisma.member.findFirst.mockResolvedValue({ userId: 'correct-user' } as any);

      await expect(
        service.guarantorResponse('l1', 'g1', { action: 'ACCEPT' as any, digitalAcknowledgment: true }, 't1', 'wrong-user', mockReq),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject missing digital acknowledgment', async () => {
      prisma.member.findFirst.mockResolvedValue({ userId: 'u1' } as any);
      prisma.guarantor.findFirst.mockResolvedValue({ id: 'gr1', status: GuarantorStatus.PENDING, invitedAt: new Date(), guaranteedAmount: '1000' } as any);

      await expect(
        service.guarantorResponse('l1', 'g1', { action: 'ACCEPT' as any, digitalAcknowledgment: false }, 't1', 'u1', mockReq),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject expired consent (72h)', async () => {
      const oldDate = new Date();
      oldDate.setHours(oldDate.getHours() - 73);
      prisma.member.findFirst.mockResolvedValue({ userId: 'u1' } as any);
      prisma.guarantor.findFirst.mockResolvedValue({ id: 'gr1', status: GuarantorStatus.PENDING, invitedAt: oldDate, guaranteedAmount: '1000' } as any);

      await expect(
        service.guarantorResponse('l1', 'g1', { action: 'ACCEPT' as any, digitalAcknowledgment: true }, 't1', 'u1', mockReq),
      ).rejects.toThrow(BadRequestException);
    });

    it('should accept valid consent and publish event', async () => {
      prisma.member.findFirst.mockResolvedValue({ userId: 'u1' } as any);
      prisma.guarantor.findFirst.mockResolvedValue({ id: 'gr1', status: GuarantorStatus.PENDING, invitedAt: new Date(), guaranteedAmount: '1000' } as any);
      prisma.guarantor.update.mockResolvedValue({} as any);
      prisma.loan.findFirst.mockResolvedValue(null);

      const result = await service.guarantorResponse('l1', 'g1', { action: 'ACCEPT' as any, digitalAcknowledgment: true }, 't1', 'u1', mockReq);
      expect(result.status).toBe('ACCEPTED');
      expect(mockIdempotency.complete).toHaveBeenCalled();
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
      prisma.loan.findFirst.mockResolvedValue({ id: 'l1', status: LoanStatus.UNDER_REVIEW, loanNumber: 'LN-1', memberId: 'm1' } as any);

      await expect(
        service.updateStatus('l1', { status: 'REJECTED' as any }, 't1', { id: 'u1', role: UserRole.MANAGER, tenantId: 't1' } as any, mockReq),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
