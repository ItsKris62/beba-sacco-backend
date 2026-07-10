import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { AccountType, JournalEntryType } from '@prisma/client';
import { AccountsService } from './accounts.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../accounting/ledger.service';

const TENANT_ID = 'tenant-uuid-1';
const ACTOR_ID = 'actor-uuid-1';

const mockPrisma = {
  member: { findFirst: jest.fn() },
  account: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  accountTypePolicy: { findUnique: jest.fn().mockResolvedValue(null) },
  tenantCounter: { upsert: jest.fn() },
  transaction: { findMany: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(),
};

const mockAudit = { create: jest.fn().mockResolvedValue(undefined) };

const mockLedger = {
  postEntry: jest.fn(),
  postInternalTransfer: jest.fn(),
};

function buildTransactionStub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'txn-1',
    accountId: 'account-1',
    balanceBefore: '1000.0000',
    balanceAfter: '1500.0000',
    reference: 'DEP-001',
    ...overrides,
  };
}

describe('AccountsService', () => {
  let service: AccountsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
        { provide: LedgerService, useValue: mockLedger },
      ],
    }).compile();

    service = module.get<AccountsService>(AccountsService);
  });

  // ── create() ──────────────────────────────────────────────────────────────

  describe('create()', () => {
    it('opens a new account with an auto-generated account number', async () => {
      mockPrisma.member.findFirst.mockResolvedValue({ id: 'member-1', memberNumber: 'M-001' });
      mockPrisma.account.findFirst.mockResolvedValue(null);
      mockPrisma.tenantCounter.upsert.mockResolvedValue({ accountSeq: 7 });
      mockPrisma.account.create.mockResolvedValue({
        id: 'account-1',
        accountNumber: 'ACC-FOSA-000007',
        accountType: AccountType.FOSA,
      });

      const result = await service.create({ memberId: 'member-1', accountType: AccountType.FOSA }, TENANT_ID, ACTOR_ID);

      expect(result.accountNumber).toBe('ACC-FOSA-000007');
      expect(mockPrisma.account.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ accountNumber: 'ACC-FOSA-000007', accountType: AccountType.FOSA, balance: 0 }),
        }),
      );
    });

    it('defaults minimumBalance/allowsNegative to 0/false when no AccountTypePolicy is configured', async () => {
      mockPrisma.member.findFirst.mockResolvedValue({ id: 'member-1', memberNumber: 'M-001' });
      mockPrisma.account.findFirst.mockResolvedValue(null);
      mockPrisma.accountTypePolicy.findUnique.mockResolvedValueOnce(null);
      mockPrisma.tenantCounter.upsert.mockResolvedValue({ accountSeq: 1 });
      mockPrisma.account.create.mockResolvedValue({ id: 'account-1', accountNumber: 'ACC-FOSA-000001' });

      await service.create({ memberId: 'member-1', accountType: AccountType.FOSA }, TENANT_ID, ACTOR_ID);

      expect(mockPrisma.account.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ minimumBalance: 0, allowsNegative: false }),
        }),
      );
    });

    it('snapshots minimumBalance/allowsNegative from the tenant AccountTypePolicy when configured', async () => {
      mockPrisma.member.findFirst.mockResolvedValue({ id: 'member-1', memberNumber: 'M-001' });
      mockPrisma.account.findFirst.mockResolvedValue(null);
      mockPrisma.accountTypePolicy.findUnique.mockResolvedValueOnce({ minimumBalance: 500, allowsNegative: true });
      mockPrisma.tenantCounter.upsert.mockResolvedValue({ accountSeq: 1 });
      mockPrisma.account.create.mockResolvedValue({ id: 'account-1', accountNumber: 'ACC-BOSA-000001' });

      await service.create({ memberId: 'member-1', accountType: AccountType.BOSA }, TENANT_ID, ACTOR_ID);

      expect(mockPrisma.accountTypePolicy.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId_accountType: { tenantId: TENANT_ID, accountType: AccountType.BOSA } } }),
      );
      expect(mockPrisma.account.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ minimumBalance: 500, allowsNegative: true }),
        }),
      );
    });

    it('throws NotFoundException when the member does not belong to the tenant', async () => {
      mockPrisma.member.findFirst.mockResolvedValue(null);

      await expect(
        service.create({ memberId: 'member-1', accountType: AccountType.FOSA }, TENANT_ID, ACTOR_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when the member already has an active account of that type', async () => {
      mockPrisma.member.findFirst.mockResolvedValue({ id: 'member-1', memberNumber: 'M-001' });
      mockPrisma.account.findFirst.mockResolvedValue({ id: 'account-existing', accountNumber: 'ACC-FOSA-000001' });

      await expect(
        service.create({ memberId: 'member-1', accountType: AccountType.FOSA }, TENANT_ID, ACTOR_ID),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── deposit() ─────────────────────────────────────────────────────────────

  describe('deposit()', () => {
    it('delegates to LedgerService.postEntry() with DEPOSIT/CREDIT and returns the new balance', async () => {
      const stubTx = buildTransactionStub();
      mockLedger.postEntry.mockResolvedValue({ transaction: stubTx, journalEntry: { id: 'je-1' } });

      const result = await service.deposit('account-1', 500, 'DEP-001', 'Cash deposit', TENANT_ID, ACTOR_ID);

      expect(mockLedger.postEntry).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        reference: 'DEP-001',
        journalType: JournalEntryType.DEPOSIT,
        accountId: 'account-1',
        amount: expect.any(Decimal),
        direction: 'CREDIT',
        actorId: ACTOR_ID,
        description: 'Cash deposit',
      });
      expect(result).toEqual({ transaction: stubTx, newBalance: 1500 });
      expect(mockAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ACCOUNT.DEPOSIT', resourceId: 'txn-1' }),
      );
    });

    it('propagates BadRequestException from LedgerService (e.g. below minimum balance)', async () => {
      mockLedger.postEntry.mockRejectedValue(new BadRequestException('Insufficient funds or below minimum balance requirement'));

      await expect(
        service.deposit('account-1', 500, 'DEP-002', 'Cash deposit', TENANT_ID, ACTOR_ID),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── withdraw() ────────────────────────────────────────────────────────────

  describe('withdraw()', () => {
    it('delegates to LedgerService.postEntry() with WITHDRAWAL/DEBIT and returns the new balance', async () => {
      const stubTx = buildTransactionStub({ balanceBefore: '1500.0000', balanceAfter: '1000.0000', reference: 'WDR-001' });
      mockLedger.postEntry.mockResolvedValue({ transaction: stubTx, journalEntry: { id: 'je-2' } });

      const result = await service.withdraw('account-1', 500, 'WDR-001', 'Cash withdrawal', TENANT_ID, ACTOR_ID);

      expect(mockLedger.postEntry).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        reference: 'WDR-001',
        journalType: JournalEntryType.WITHDRAWAL,
        accountId: 'account-1',
        amount: expect.any(Decimal),
        direction: 'DEBIT',
        actorId: ACTOR_ID,
        description: 'Cash withdrawal',
      });
      expect(result).toEqual({ transaction: stubTx, newBalance: 1000 });
      expect(mockAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ACCOUNT.WITHDRAW', resourceId: 'txn-1' }),
      );
    });
  });

  // ── transfer() ────────────────────────────────────────────────────────────

  describe('transfer()', () => {
    it('validates same-member ownership then delegates to LedgerService.postInternalTransfer()', async () => {
      mockPrisma.account.findFirst
        .mockResolvedValueOnce({ id: 'fosa-1', memberId: 'member-1' })
        .mockResolvedValueOnce({ id: 'bosa-1', memberId: 'member-1' });
      mockLedger.postInternalTransfer.mockResolvedValue({
        fromTransaction: buildTransactionStub({ id: 'txn-from', balanceAfter: '700.0000' }),
        toTransaction: buildTransactionStub({ id: 'txn-to', balanceAfter: '2300.0000' }),
        journalEntry: { id: 'je-transfer' },
      });

      const result = await service.transfer(
        'fosa-1',
        { destinationAccountId: 'bosa-1', amount: 300, idempotencyKey: 'idem-transfer-001' },
        TENANT_ID,
        ACTOR_ID,
      );

      expect(mockLedger.postInternalTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          fromAccountId: 'fosa-1',
          toAccountId: 'bosa-1',
          actorId: ACTOR_ID,
          reference: `XFER-${TENANT_ID}-idem-transfer-001`,
        }),
      );
      expect(result.newSourceBalance).toBe(700);
      expect(result.newDestinationBalance).toBe(2300);
      expect(mockAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ACCOUNT.TRANSFER' }),
      );
    });

    it('rejects transferring an account to itself before touching the DB', async () => {
      await expect(
        service.transfer('fosa-1', { destinationAccountId: 'fosa-1', amount: 100, idempotencyKey: 'idem-self' }, TENANT_ID, ACTOR_ID),
      ).rejects.toThrow(BadRequestException);

      expect(mockPrisma.account.findFirst).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the source account does not exist', async () => {
      mockPrisma.account.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.transfer('fosa-1', { destinationAccountId: 'bosa-1', amount: 100, idempotencyKey: 'idem-missing-source' }, TENANT_ID, ACTOR_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when the accounts belong to different members', async () => {
      mockPrisma.account.findFirst
        .mockResolvedValueOnce({ id: 'fosa-1', memberId: 'member-1' })
        .mockResolvedValueOnce({ id: 'bosa-1', memberId: 'member-2' });

      await expect(
        service.transfer('fosa-1', { destinationAccountId: 'bosa-1', amount: 100, idempotencyKey: 'idem-cross-member' }, TENANT_ID, ACTOR_ID),
      ).rejects.toThrow(ForbiddenException);

      expect(mockLedger.postInternalTransfer).not.toHaveBeenCalled();
    });
  });
});
