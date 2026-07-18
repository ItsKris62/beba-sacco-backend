import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { AccountType, JournalEntryType, JournalEntryStatus, TransactionType, TransactionStatus, UserRole } from '@prisma/client';
import { LedgerService } from '../ledger.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';

const TENANT_ID = 'tenant-uuid-1';
const ACTOR_ID = 'actor-uuid-1';
const SYSTEM_USER_ID = 'system-user-uuid-1';

const mockPrisma = {
  $transaction: jest.fn(),
  user: { findFirst: jest.fn().mockResolvedValue({ id: SYSTEM_USER_ID }) },
};
const mockAudit = { create: jest.fn().mockResolvedValue(undefined) };

const CASH_GL = { id: 'gl-cash', code: '1000' };
const LOAN_RECEIVABLE_GL = { id: 'gl-loan-receivable', code: '1300' };
const FOSA_GL = { id: 'gl-fosa-deposits', code: '2300' };
const BOSA_GL = { id: 'gl-bosa-deposits', code: '2400' };
const INTEREST_INCOME_GL = { id: 'gl-interest-income', code: '4000' };
const PENALTY_INCOME_GL = { id: 'gl-penalty-income', code: '4200' };
const FEE_INCOME_GL = { id: 'gl-fee-income', code: '4300' };

const ALL_GL_ACCOUNTS = [CASH_GL, LOAN_RECEIVABLE_GL, FOSA_GL, BOSA_GL, INTEREST_INCOME_GL, PENALTY_INCOME_GL, FEE_INCOME_GL];

function buildTx(overrides: Record<string, any> = {}) {
  return {
    transaction: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
    account: {
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    gLAccount: {
      findMany: jest.fn().mockResolvedValue(ALL_GL_ACCOUNTS),
    },
    journalEntry: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    ...overrides,
  };
}

describe('LedgerService', () => {
  let service: LedgerService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LedgerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get<LedgerService>(LedgerService);
  });

  // ── postEntry() ──────────────────────────────────────────────────────────────

  describe('postEntry()', () => {
    it('posts a DEPOSIT: debits CASH, credits the FOSA deposits GL account, exactly once', async () => {
      const tx = buildTx();
      tx.account.findFirst.mockResolvedValue({
        balance: '1000.0000',
        minimumBalance: '0.0000',
        allowsNegative: false,
        accountType: AccountType.FOSA,
      });
      tx.transaction.create.mockResolvedValue({ id: 'txn-1' });
      tx.journalEntry.create.mockResolvedValue({ id: 'je-1' });
      (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (cb) => cb(tx));

      const result = await service.postEntry({
        tenantId: TENANT_ID,
        reference: 'DEP-001',
        journalType: JournalEntryType.DEPOSIT,
        accountId: 'account-1',
        amount: new Decimal(500),
        direction: 'CREDIT',
        actorId: ACTOR_ID,
      });

      expect(result.transaction.id).toBe('txn-1');
      expect(result.journalEntry.id).toBe('je-1');

      // Exactly one Transaction row and one JournalEntry — no double posting.
      expect(tx.transaction.create).toHaveBeenCalledTimes(1);
      expect(tx.journalEntry.create).toHaveBeenCalledTimes(1);

      expect(tx.transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: TransactionType.DEPOSIT,
            balanceBefore: '1000',
            balanceAfter: '1500',
            reference: 'DEP-001',
          }),
        }),
      );

      // Double-entry integrity: single posting, debit CASH / credit FOSA deposits liability.
      const createCall = tx.journalEntry.create.mock.calls[0][0];
      expect(createCall.data.status).toBe(JournalEntryStatus.POSTED);
      expect(createCall.data.postings.create).toHaveLength(1);
      expect(createCall.data.postings.create[0]).toEqual(
        expect.objectContaining({
          debitAccountId: CASH_GL.id,
          creditAccountId: FOSA_GL.id,
          amount: '500',
        }),
      );
      expect(createCall.data.totalAmount).toBe('500');
    });

    it('replays an idempotent reference without writing anything new', async () => {
      const existingTx = { id: 'txn-existing', reference: 'DEP-001' };
      const existingEntry = { id: 'je-existing', referenceId: 'txn-existing' };

      const tx = buildTx();
      tx.transaction.findFirst.mockResolvedValue(existingTx);
      tx.journalEntry.findFirst.mockResolvedValue(existingEntry);
      (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (cb) => cb(tx));

      const result = await service.postEntry({
        tenantId: TENANT_ID,
        reference: 'DEP-001',
        journalType: JournalEntryType.DEPOSIT,
        accountId: 'account-1',
        amount: new Decimal(500),
        direction: 'CREDIT',
        actorId: ACTOR_ID,
      });

      expect(result.transaction).toBe(existingTx);
      expect(result.journalEntry).toBe(existingEntry);
      expect(tx.account.findFirst).not.toHaveBeenCalled();
      expect(tx.account.updateMany).not.toHaveBeenCalled();
      expect(tx.transaction.create).not.toHaveBeenCalled();
      expect(tx.journalEntry.create).not.toHaveBeenCalled();
      expect(mockAudit.create).not.toHaveBeenCalled();
    });

    it('rejects a WITHDRAWAL that would breach the minimum-balance floor, writing nothing', async () => {
      const tx = buildTx();
      tx.account.findFirst.mockResolvedValue({
        balance: '1000.0000',
        minimumBalance: '500.0000',
        allowsNegative: false,
        accountType: AccountType.FOSA,
      });
      // Simulate the DB's conditional WHERE (balance >= minimumBalance + amount) failing.
      tx.account.updateMany.mockResolvedValue({ count: 0 });
      (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (cb) => cb(tx));

      await expect(
        service.postEntry({
          tenantId: TENANT_ID,
          reference: 'WDR-001',
          journalType: JournalEntryType.WITHDRAWAL,
          accountId: 'account-1',
          amount: new Decimal(600), // 1000 - 600 = 400 < minimumBalance 500
          direction: 'DEBIT',
          actorId: ACTOR_ID,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(tx.transaction.create).not.toHaveBeenCalled();
      expect(tx.journalEntry.create).not.toHaveBeenCalled();
    });

    it('rejects a WITHDRAWAL that would dip into guarantor-held funds (lockedBalance/frozenSavings), writing nothing', async () => {
      const tx = buildTx();
      tx.account.findFirst.mockResolvedValue({
        balance: '1000.0000',
        minimumBalance: '0.0000',
        allowsNegative: false,
        accountType: AccountType.FOSA,
        lockedBalance: '0.0000',
        frozenSavings: '600.0000', // e.g. held as guarantor collateral
      });
      // Available = 1000 - 0 - 600 = 400, which is below the requested 500.
      tx.account.updateMany.mockResolvedValue({ count: 0 });
      (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (cb) => cb(tx));

      await expect(
        service.postEntry({
          tenantId: TENANT_ID,
          reference: 'WDR-002',
          journalType: JournalEntryType.WITHDRAWAL,
          accountId: 'account-1',
          amount: new Decimal(500),
          direction: 'DEBIT',
          actorId: ACTOR_ID,
        }),
      ).rejects.toThrow(BadRequestException);

      // The compare-and-swap floor must include the frozen amount: balance >= frozenSavings + amount.
      expect(tx.account.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ balance: { gte: '1100' } }),
        }),
      );
      expect(tx.transaction.create).not.toHaveBeenCalled();
      expect(tx.journalEntry.create).not.toHaveBeenCalled();
    });

    it('permits a WITHDRAWAL that stays within the balance not committed to guarantor holds', async () => {
      const tx = buildTx();
      tx.account.findFirst.mockResolvedValue({
        balance: '1000.0000',
        minimumBalance: '0.0000',
        allowsNegative: false,
        accountType: AccountType.FOSA,
        lockedBalance: '0.0000',
        frozenSavings: '600.0000',
      });
      tx.transaction.create.mockResolvedValue({ id: 'txn-wdr-ok' });
      tx.journalEntry.create.mockResolvedValue({ id: 'je-wdr-ok' });
      (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (cb) => cb(tx));

      // Available = 1000 - 600 = 400 >= requested 300.
      const result = await service.postEntry({
        tenantId: TENANT_ID,
        reference: 'WDR-003',
        journalType: JournalEntryType.WITHDRAWAL,
        accountId: 'account-1',
        amount: new Decimal(300),
        direction: 'DEBIT',
        actorId: ACTOR_ID,
      });

      expect(result.transaction.id).toBe('txn-wdr-ok');
      // Compare-and-swap floor: balance >= frozenSavings + amount = 600 + 300 = 900.
      expect(tx.account.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ balance: { gte: '900' } }) }),
      );
    });

    it('enforces the guarantor-hold floor even when allowsNegative is true', async () => {
      const tx = buildTx();
      tx.account.findFirst.mockResolvedValue({
        balance: '1000.0000',
        minimumBalance: '500.0000',
        allowsNegative: true, // would normally bypass the minimum-balance floor entirely
        accountType: AccountType.FOSA,
        lockedBalance: '0.0000',
        frozenSavings: '600.0000',
      });
      tx.account.updateMany.mockResolvedValue({ count: 0 });
      (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (cb) => cb(tx));

      await expect(
        service.postEntry({
          tenantId: TENANT_ID,
          reference: 'WDR-004',
          journalType: JournalEntryType.WITHDRAWAL,
          accountId: 'account-1',
          amount: new Decimal(500),
          direction: 'DEBIT',
          actorId: ACTOR_ID,
        }),
      ).rejects.toThrow(BadRequestException);

      // allowsNegative waives the minimumBalance floor (policyFloor=0), but never the
      // committed-funds floor: balance >= frozenSavings + amount = 600 + 500 = 1100.
      expect(tx.account.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ balance: { gte: '1100' } }) }),
      );
    });

    it('falls back to the tenant SYSTEM user when actorId is omitted, and memoizes the lookup', async () => {
      const tx = buildTx();
      tx.account.findFirst.mockResolvedValue({
        balance: '1000.0000',
        minimumBalance: '0.0000',
        allowsNegative: false,
        accountType: AccountType.FOSA,
      });
      tx.transaction.create.mockResolvedValue({ id: 'txn-sys-1' });
      tx.journalEntry.create.mockResolvedValue({ id: 'je-sys-1' });
      (mockPrisma.$transaction as jest.Mock)
        .mockImplementationOnce(async (cb) => cb(tx))
        .mockImplementationOnce(async (cb) => cb(buildTx({
          account: {
            findFirst: jest.fn().mockResolvedValue({
              balance: '2000.0000',
              minimumBalance: '0.0000',
              allowsNegative: false,
              accountType: AccountType.FOSA,
            }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          transaction: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'txn-sys-2' }) },
          journalEntry: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'je-sys-2' }) },
        })));

      await service.postEntry({
        tenantId: TENANT_ID,
        reference: 'DEP-002',
        journalType: JournalEntryType.DEPOSIT,
        accountId: 'account-1',
        amount: new Decimal(500),
        direction: 'CREDIT',
      });
      await service.postEntry({
        tenantId: TENANT_ID,
        reference: 'DEP-003',
        journalType: JournalEntryType.DEPOSIT,
        accountId: 'account-2',
        amount: new Decimal(100),
        direction: 'CREDIT',
      });

      expect(tx.transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ processedBy: SYSTEM_USER_ID }) }),
      );
      // Two postEntry() calls for the same tenant, but only ONE user.findFirst lookup — memoized.
      expect(mockPrisma.user.findFirst).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: TENANT_ID, role: UserRole.SYSTEM } }),
      );
    });

    it('throws NotFoundException if the tenant has no SYSTEM user provisioned', async () => {
      // resolveSystemActorId() rejects before postEntry() ever opens $transaction —
      // no tx mock needed here.
      mockPrisma.user.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.postEntry({
          tenantId: 'unprovisioned-tenant',
          reference: 'DEP-004',
          journalType: JournalEntryType.DEPOSIT,
          accountId: 'account-1',
          amount: new Decimal(500),
          direction: 'CREDIT',
        }),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('posts a LOAN_DISBURSEMENT: debits LOAN_RECEIVABLE, credits the FOSA deposits GL account', async () => {
      const tx = buildTx();
      tx.account.findFirst.mockResolvedValue({
        balance: '0.0000',
        minimumBalance: '0.0000',
        allowsNegative: false,
        accountType: AccountType.FOSA,
      });
      tx.transaction.create.mockResolvedValue({ id: 'txn-disb-1' });
      tx.journalEntry.create.mockResolvedValue({ id: 'je-disb-1' });
      (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (cb) => cb(tx));

      await service.postEntry({
        tenantId: TENANT_ID,
        reference: 'LOAN-DISBURSEMENT-loan-1',
        journalType: JournalEntryType.LOAN_DISBURSEMENT,
        accountId: 'account-1',
        amount: new Decimal(50000),
        direction: 'CREDIT',
        actorId: ACTOR_ID,
      });

      expect(tx.transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: TransactionType.LOAN_DISBURSEMENT }) }),
      );
      const createCall = tx.journalEntry.create.mock.calls[0][0];
      expect(createCall.data.postings.create[0]).toEqual(
        expect.objectContaining({ debitAccountId: LOAN_RECEIVABLE_GL.id, creditAccountId: FOSA_GL.id, amount: '50000' }),
      );
    });

    it('posts a FEE_CHARGE: debits the FOSA deposits GL account, credits FEE_INCOME', async () => {
      const tx = buildTx();
      tx.account.findFirst.mockResolvedValue({
        balance: '50000.0000',
        minimumBalance: '0.0000',
        allowsNegative: false,
        accountType: AccountType.FOSA,
      });
      tx.transaction.create.mockResolvedValue({ id: 'txn-fee-1' });
      tx.journalEntry.create.mockResolvedValue({ id: 'je-fee-1' });
      (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (cb) => cb(tx));

      await service.postEntry({
        tenantId: TENANT_ID,
        reference: 'LOAN-DISBURSEMENT-loan-1-FEE',
        journalType: JournalEntryType.FEE_CHARGE,
        accountId: 'account-1',
        amount: new Decimal(500),
        direction: 'DEBIT',
        actorId: ACTOR_ID,
      });

      const createCall = tx.journalEntry.create.mock.calls[0][0];
      expect(createCall.data.postings.create[0]).toEqual(
        expect.objectContaining({ debitAccountId: FOSA_GL.id, creditAccountId: FEE_INCOME_GL.id, amount: '500' }),
      );
    });

    it('participates in a caller-supplied tx instead of opening its own, and skips the internal audit write', async () => {
      const tx = buildTx();
      tx.account.findFirst.mockResolvedValue({
        balance: '0.0000',
        minimumBalance: '0.0000',
        allowsNegative: false,
        accountType: AccountType.FOSA,
      });
      tx.transaction.create.mockResolvedValue({ id: 'txn-caller-tx-1' });
      tx.journalEntry.create.mockResolvedValue({ id: 'je-caller-tx-1' });
      mockAudit.create.mockClear();

      const result = await service.postEntry({
        tenantId: TENANT_ID,
        reference: 'LOAN-DISBURSEMENT-loan-2',
        journalType: JournalEntryType.LOAN_DISBURSEMENT,
        accountId: 'account-1',
        amount: new Decimal(20000),
        direction: 'CREDIT',
        actorId: ACTOR_ID,
        tx: tx as any,
      });

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(result.transaction.id).toBe('txn-caller-tx-1');
      expect(mockAudit.create).not.toHaveBeenCalled();
    });
  });

  // ── postLoanRepaymentLegEntry() ──────────────────────────────────────────────

  describe('postLoanRepaymentLegEntry()', () => {
    it.each([
      ['PENALTY', PENALTY_INCOME_GL],
      ['INTEREST', INTEREST_INCOME_GL],
      ['PRINCIPAL', LOAN_RECEIVABLE_GL],
    ] as const)('posts the %s leg: debits CASH, credits the correct income/receivable GL account', async (leg, expectedCreditGl) => {
      const tx = buildTx();
      tx.journalEntry.create.mockResolvedValue({ id: `je-${leg}-1` });

      const result = await service.postLoanRepaymentLegEntry({
        tx: tx as any,
        tenantId: TENANT_ID,
        reference: `REPAY-001-${leg}`,
        leg,
        amount: new Decimal(300),
        transactionId: 'txn-alloc-1',
        actorId: ACTOR_ID,
      });

      expect(result.replayed).toBe(false);
      expect(tx.journalEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: JournalEntryType.LOAN_REPAYMENT,
            postings: {
              create: [expect.objectContaining({ debitAccountId: CASH_GL.id, creditAccountId: expectedCreditGl.id, amount: '300' })],
            },
          }),
        }),
      );
      // GL-only: no Account or operational Transaction touched.
      expect(tx.account.updateMany).not.toHaveBeenCalled();
      expect(tx.transaction.create).not.toHaveBeenCalled();
    });

    it('replays idempotently when a JournalEntry with the same derived entryNumber already exists', async () => {
      const tx = buildTx();
      tx.journalEntry.findFirst.mockResolvedValue({ id: 'je-existing-1' });

      const result = await service.postLoanRepaymentLegEntry({
        tx: tx as any,
        tenantId: TENANT_ID,
        reference: 'REPAY-001-PENALTY',
        leg: 'PENALTY',
        amount: new Decimal(300),
        transactionId: 'txn-alloc-1',
        actorId: ACTOR_ID,
      });

      expect(result).toEqual({ journalEntry: { id: 'je-existing-1' }, replayed: true });
      expect(tx.journalEntry.create).not.toHaveBeenCalled();
    });
  });

  // ── postAccountSourcedRepaymentLegEntry() ────────────────────────────────────

  describe('postAccountSourcedRepaymentLegEntry()', () => {
    it.each([
      ['PENALTY', PENALTY_INCOME_GL],
      ['INTEREST', INTEREST_INCOME_GL],
      ['PRINCIPAL', LOAN_RECEIVABLE_GL],
    ] as const)('posts the %s leg: debits FOSA_DEPOSITS (not CASH), credits the correct income/receivable GL account', async (leg, expectedCreditGl) => {
      const tx = buildTx();
      tx.journalEntry.create.mockResolvedValue({ id: `je-acct-${leg}-1` });

      const result = await service.postAccountSourcedRepaymentLegEntry({
        tx: tx as any,
        tenantId: TENANT_ID,
        reference: `REPAY-002-${leg}`,
        leg,
        amount: new Decimal(300),
        accountType: AccountType.FOSA,
        transactionId: 'txn-alloc-2',
        actorId: ACTOR_ID,
      });

      expect(result.replayed).toBe(false);
      expect(tx.journalEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            postings: {
              create: [expect.objectContaining({ debitAccountId: FOSA_GL.id, creditAccountId: expectedCreditGl.id, amount: '300' })],
            },
          }),
        }),
      );
      // Deliberately does not touch any Account balance — the caller (LoansService.
      // repay()) decrements it exactly once, separately, for the total amount.
      expect(tx.account.updateMany).not.toHaveBeenCalled();
      expect(tx.transaction.create).not.toHaveBeenCalled();
    });

    it('resolves BOSA_DEPOSITS as the debit code for a BOSA-sourced repayment', async () => {
      const tx = buildTx();
      tx.journalEntry.create.mockResolvedValue({ id: 'je-acct-bosa-1' });

      await service.postAccountSourcedRepaymentLegEntry({
        tx: tx as any,
        tenantId: TENANT_ID,
        reference: 'REPAY-003-PRINCIPAL',
        leg: 'PRINCIPAL',
        amount: new Decimal(500),
        accountType: AccountType.BOSA,
        transactionId: 'txn-alloc-3',
        actorId: ACTOR_ID,
      });

      expect(tx.journalEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            postings: {
              create: [expect.objectContaining({ debitAccountId: BOSA_GL.id, creditAccountId: LOAN_RECEIVABLE_GL.id })],
            },
          }),
        }),
      );
    });
  });

  // ── postInternalTransfer() ───────────────────────────────────────────────────

  describe('postInternalTransfer()', () => {
    it('writes two linked Transaction rows but exactly one JournalEntry netting the two liability accounts', async () => {
      const tx = buildTx();
      tx.account.findFirst
        .mockResolvedValueOnce({
          balance: '1000.0000',
          minimumBalance: '0.0000',
          allowsNegative: false,
          accountType: AccountType.FOSA,
        })
        .mockResolvedValueOnce({
          balance: '2000.0000',
          minimumBalance: '0.0000',
          allowsNegative: false,
          accountType: AccountType.BOSA,
        });
      tx.transaction.create
        .mockResolvedValueOnce({ id: 'txn-from' })
        .mockResolvedValueOnce({ id: 'txn-to' });
      tx.journalEntry.create.mockResolvedValue({ id: 'je-transfer' });
      (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (cb) => cb(tx));

      const result = await service.postInternalTransfer({
        tenantId: TENANT_ID,
        fromAccountId: 'fosa-account-1',
        toAccountId: 'bosa-account-1',
        amount: new Decimal(300),
        reference: 'XFER-001',
        actorId: ACTOR_ID,
      });

      // Two operational legs...
      expect(tx.transaction.create).toHaveBeenCalledTimes(2);
      expect(tx.transaction.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({
            accountId: 'fosa-account-1',
            reference: 'XFER-001-SRC',
            balanceBefore: '1000',
            balanceAfter: '700',
          }),
        }),
      );
      expect(tx.transaction.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            accountId: 'bosa-account-1',
            reference: 'XFER-001-DST',
            balanceBefore: '2000',
            balanceAfter: '2300',
            linkedTransactionId: 'txn-from',
          }),
        }),
      );

      // ...linked both ways.
      expect(tx.transaction.update).toHaveBeenCalledWith({
        where: { id: 'txn-from' },
        data: { linkedTransactionId: 'txn-to' },
      });

      // ...but exactly ONE journal entry (no double-counting the GL impact).
      expect(tx.journalEntry.create).toHaveBeenCalledTimes(1);
      const createCall = tx.journalEntry.create.mock.calls[0][0];
      expect(createCall.data.type).toBe(JournalEntryType.TRANSFER);
      expect(createCall.data.postings.create).toHaveLength(1);
      expect(createCall.data.postings.create[0]).toEqual(
        expect.objectContaining({
          debitAccountId: FOSA_GL.id,
          creditAccountId: BOSA_GL.id,
          amount: '300',
        }),
      );

      expect(result.fromTransaction.id).toBe('txn-from');
      expect(result.toTransaction.id).toBe('txn-to');
      expect(result.journalEntry.id).toBe('je-transfer');
    });

    it('rejects transferring an account to itself before writing anything', async () => {
      const tx = buildTx();
      (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (cb) => cb(tx));

      await expect(
        service.postInternalTransfer({
          tenantId: TENANT_ID,
          fromAccountId: 'account-1',
          toAccountId: 'account-1',
          amount: new Decimal(100),
          reference: 'XFER-002',
          actorId: ACTOR_ID,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(tx.account.findFirst).not.toHaveBeenCalled();
    });
  });
});
