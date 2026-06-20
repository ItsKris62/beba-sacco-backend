import { Test, TestingModule } from '@nestjs/testing';
import {
  GLAccountType,
  MpesaTxType,
  JournalEntryStatus,
  JournalEntryType,
  TransactionStatus,
} from '@prisma/client';
import { AccountingService } from '../accounting.service';
import { AccountingController } from '../accounting.controller';
import { PrismaService } from '../../../prisma/prisma.service';
import { ReconciliationService } from '../../financial/reconciliation.service';
import { AuditService } from '../../audit/audit.service';

// ─── Stubs ────────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-uuid-1';

const mockPrisma = {
  transaction: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  account: { groupBy: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  loan: { groupBy: jest.fn() },
  mpesaTransaction: {
    count: jest.fn(),
    findMany: jest.fn(),
    aggregate: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  journalEntry: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  gLAccount: {
    findMany: jest.fn(),
    count: jest.fn(),
    upsert: jest.fn(),
  },
  gLPosting: {
    findMany: jest.fn(),
    count: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockRecon = {
  getLatestReport: jest.fn(),
  $transaction: jest.fn(),
};
const mockAudit = { create: jest.fn().mockResolvedValue(undefined) };

function buildTxStub(overrides = {}) {
  return {
    id: 'txn-uuid-1',
    accountId: 'account-uuid-1',
    type: 'DEPOSIT',
    amount: '5000.0000',
    balanceBefore: '10000.0000',
    balanceAfter: '15000.0000',
    reference: 'DEP-001',
    description: 'Test deposit',
    createdAt: new Date('2026-05-08T10:00:00Z'),
    account: { accountNumber: 'ACC-FOSA-000001', accountType: 'FOSA' },
    ...overrides,
  };
}

// ─── AccountingService unit tests ─────────────────────────────────────────────

describe('AccountingService', () => {
  let service: AccountingService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.transaction.count.mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ReconciliationService, useValue: mockRecon },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get<AccountingService>(AccountingService);
  });

  // ── getLedger ──────────────────────────────────────────────────────────────

  describe('getLedger()', () => {
    it('returns grouped data with meta', async () => {
      mockPrisma.transaction.findMany.mockResolvedValueOnce([buildTxStub()]);
      mockPrisma.transaction.count.mockResolvedValueOnce(1);

      const result = await service.getLedger(TENANT_ID, {});

      expect(result.data).toHaveLength(1);
      expect(result.meta).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });
    });

    it('applies skip and take pagination to the transaction query', async () => {
      mockPrisma.transaction.findMany.mockResolvedValueOnce([buildTxStub()]);
      mockPrisma.transaction.count.mockResolvedValueOnce(35);

      const result = await service.getLedger(TENANT_ID, { page: 2, limit: 10 });

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
      expect(mockPrisma.transaction.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ tenantId: TENANT_ID, status: TransactionStatus.COMPLETED }),
      });
      expect(result.meta).toMatchObject({ page: 2, limit: 10, total: 35, totalPages: 4 });
    });

    it('groups transactions by accountId + date', async () => {
      const txA1 = buildTxStub({ createdAt: new Date('2026-05-08T08:00:00Z') });
      const txA2 = buildTxStub({
        id: 'txn-uuid-2',
        createdAt: new Date('2026-05-08T12:00:00Z'),
        amount: '3000.0000',
        balanceBefore: '15000.0000',
        balanceAfter: '18000.0000',
      });
      const txB = buildTxStub({
        id: 'txn-uuid-3',
        accountId: 'account-uuid-2',
        createdAt: new Date('2026-05-08T09:00:00Z'),
        account: { accountNumber: 'ACC-BOSA-000001', accountType: 'BOSA' },
      });

      mockPrisma.transaction.findMany.mockResolvedValueOnce([txA1, txA2, txB]);

      const result = await service.getLedger(TENANT_ID, {});

      // Two groups: account-uuid-1 on 2026-05-08 and account-uuid-2 on 2026-05-08
      expect(result.data).toHaveLength(2);
    });

    it('computes totalIn for credit transaction types', async () => {
      const tx = buildTxStub({ type: 'DEPOSIT', amount: '5000.0000' });
      mockPrisma.transaction.findMany.mockResolvedValueOnce([tx]);

      const result = await service.getLedger(TENANT_ID, {});
      expect(result.data[0].totalIn).toBe(5000);
      expect(result.data[0].totalOut).toBe(0);
    });

    it('computes totalOut for debit transaction types', async () => {
      const tx = buildTxStub({ type: 'LOAN_REPAYMENT', amount: '4000.0000' });
      mockPrisma.transaction.findMany.mockResolvedValueOnce([tx]);

      const result = await service.getLedger(TENANT_ID, {});
      expect(result.data[0].totalOut).toBe(4000);
      expect(result.data[0].totalIn).toBe(0);
    });

    it('uses balanceBefore of first tx as openingBalance', async () => {
      const tx = buildTxStub({ balanceBefore: '10000.0000' });
      mockPrisma.transaction.findMany.mockResolvedValueOnce([tx]);

      const result = await service.getLedger(TENANT_ID, {});
      expect(result.data[0].openingBalance).toBe(10000);
    });

    it('uses balanceAfter of last tx as closingBalance', async () => {
      const tx = buildTxStub({ balanceAfter: '15000.0000' });
      mockPrisma.transaction.findMany.mockResolvedValueOnce([tx]);

      const result = await service.getLedger(TENANT_ID, {});
      expect(result.data[0].closingBalance).toBe(15000);
    });

    it('includes transactions array when accountId is provided', async () => {
      const tx = buildTxStub();
      mockPrisma.transaction.findMany.mockResolvedValueOnce([tx]);

      const result = await service.getLedger(TENANT_ID, { accountId: 'account-uuid-1' });
      expect(result.data[0]).toHaveProperty('transactions');
      expect(result.data[0].transactions).toHaveLength(1);
    });

    it('omits transactions array when no accountId (summary mode)', async () => {
      mockPrisma.transaction.findMany.mockResolvedValueOnce([buildTxStub()]);

      const result = await service.getLedger(TENANT_ID, {});
      expect(result.data[0]).not.toHaveProperty('transactions');
    });

    it('returns empty data when no transactions in range', async () => {
      mockPrisma.transaction.findMany.mockResolvedValueOnce([]);

      const result = await service.getLedger(TENANT_ID, { startDate: '2026-06-01', endDate: '2026-06-30' });
      expect(result.data).toHaveLength(0);
    });
  });

  // ── getReconciliation ──────────────────────────────────────────────────────

  describe('getReconciliation()', () => {
    it('returns cachedReport from ReconciliationService', async () => {
      const report = { settlementDate: '2026-05-08', totalDaraja: 250000, totalPosted: 250000, mismatches: [], duplicates: [], autoResolved: 0, tenantId: TENANT_ID };
      mockRecon.getLatestReport.mockResolvedValueOnce(report);
      mockPrisma.mpesaTransaction.count.mockResolvedValueOnce(0);
      mockPrisma.mpesaTransaction.findMany.mockResolvedValueOnce([]);

      const result = await service.getReconciliation(TENANT_ID, { date: '2026-05-08' });

      expect(result.cachedReport).toBe(report);
      expect(mockRecon.getLatestReport).toHaveBeenCalledWith(TENANT_ID, '2026-05-08');
    });

    it('returns cachedReport: null when no cached report exists', async () => {
      mockRecon.getLatestReport.mockResolvedValueOnce(null);
      mockPrisma.mpesaTransaction.count.mockResolvedValueOnce(0);
      mockPrisma.mpesaTransaction.findMany.mockResolvedValueOnce([]);

      const result = await service.getReconciliation(TENANT_ID, {});
      expect(result.cachedReport).toBeNull();
    });

    it('defaults settlement date to today', async () => {
      mockRecon.getLatestReport.mockResolvedValueOnce(null);
      mockPrisma.mpesaTransaction.count.mockResolvedValueOnce(0);
      mockPrisma.mpesaTransaction.findMany.mockResolvedValueOnce([]);

      await service.getReconciliation(TENANT_ID, {});

      const today = new Date().toISOString().split('T')[0];
      expect(mockRecon.getLatestReport).toHaveBeenCalledWith(TENANT_ID, today);
    });

    it('returns reconPending count and transactions', async () => {
      mockRecon.getLatestReport.mockResolvedValueOnce(null);
      mockPrisma.mpesaTransaction.count.mockResolvedValueOnce(3);
      mockPrisma.mpesaTransaction.findMany.mockResolvedValueOnce([
        { id: 'mpesa-1', checkoutRequestId: 'ws_123', amount: '1000.0000', phoneNumber: '254700000001', createdAt: new Date(), updatedAt: new Date(), mpesaReceiptNumber: null },
      ]);

      const result = await service.getReconciliation(TENANT_ID, {});

      expect(result.reconPending.count).toBe(3);
      expect(result.reconPending.transactions).toHaveLength(1);
      expect(typeof result.reconPending.transactions[0].amount).toBe('number');
    });

    it('queries RECON_PENDING status for live transactions', async () => {
      mockRecon.getLatestReport.mockResolvedValueOnce(null);
      mockPrisma.mpesaTransaction.count.mockResolvedValueOnce(0);
      mockPrisma.mpesaTransaction.findMany.mockResolvedValueOnce([]);

      await service.getReconciliation(TENANT_ID, {});

      expect(mockPrisma.mpesaTransaction.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: TENANT_ID,
            status: TransactionStatus.RECON_PENDING,
          }),
        }),
      );
    });
  });

  // ── getReport ──────────────────────────────────────────────────────────────

  describe('getReport()', () => {
    it('returns accountBook from account groupBy', async () => {
      mockPrisma.account.groupBy.mockResolvedValueOnce([
        { accountType: 'FOSA', _sum: { balance: '5000000.0000' }, _count: { id: 120 } },
        { accountType: 'BOSA', _sum: { balance: '8000000.0000' }, _count: { id: 118 } },
      ]);
      mockPrisma.loan.groupBy.mockResolvedValueOnce([]);
      mockPrisma.mpesaTransaction.aggregate.mockResolvedValueOnce({ _sum: { amount: null }, _count: { id: 0 } });

      const result = await service.getReport(TENANT_ID, {});

      expect(result.accountBook).toHaveLength(2);
      expect(result.accountBook[0].accountType).toBe('FOSA');
      expect(result.accountBook[0].totalBalance).toBe(5000000);
    });

    it('returns loanBook from loan groupBy with numeric conversions', async () => {
      mockPrisma.account.groupBy.mockResolvedValueOnce([]);
      mockPrisma.loan.groupBy.mockResolvedValueOnce([
        { status: 'ACTIVE', _count: { id: 45 }, _sum: { principalAmount: '9000000.0000', outstandingBalance: '7200000.0000' } },
      ]);
      mockPrisma.mpesaTransaction.aggregate.mockResolvedValueOnce({ _sum: { amount: null }, _count: { id: 0 } });

      const result = await service.getReport(TENANT_ID, {});

      expect(result.loanBook[0].count).toBe(45);
      expect(result.loanBook[0].totalPrincipal).toBe(9000000);
      expect(result.loanBook[0].totalOutstanding).toBe(7200000);
    });

    it('returns mpesaVolume as 0 when no completed transactions', async () => {
      mockPrisma.account.groupBy.mockResolvedValueOnce([]);
      mockPrisma.loan.groupBy.mockResolvedValueOnce([]);
      mockPrisma.mpesaTransaction.aggregate.mockResolvedValueOnce({
        _sum: { amount: null },
        _count: { id: 0 },
      });

      const result = await service.getReport(TENANT_ID, {});

      expect(result.mpesaVolume.totalAmount).toBe(0);
      expect(result.mpesaVolume.transactionCount).toBe(0);
    });

    it('returns mpesaVolume with numeric amount', async () => {
      mockPrisma.account.groupBy.mockResolvedValueOnce([]);
      mockPrisma.loan.groupBy.mockResolvedValueOnce([]);
      mockPrisma.mpesaTransaction.aggregate.mockResolvedValueOnce({
        _sum: { amount: '3500000.0000' },
        _count: { id: 210 },
      });

      const result = await service.getReport(TENANT_ID, {});

      expect(result.mpesaVolume.totalAmount).toBe(3500000);
      expect(result.mpesaVolume.transactionCount).toBe(210);
    });

    it('includes generatedAt ISO timestamp', async () => {
      mockPrisma.account.groupBy.mockResolvedValueOnce([]);
      mockPrisma.loan.groupBy.mockResolvedValueOnce([]);
      mockPrisma.mpesaTransaction.aggregate.mockResolvedValueOnce({ _sum: { amount: null }, _count: { id: 0 } });

      const result = await service.getReport(TENANT_ID, {});

      expect(typeof result.generatedAt).toBe('string');
      expect(() => new Date(result.generatedAt)).not.toThrow();
    });

    it('enforces tenantId on all three queries', async () => {
      mockPrisma.account.groupBy.mockResolvedValueOnce([]);
      mockPrisma.loan.groupBy.mockResolvedValueOnce([]);
      mockPrisma.mpesaTransaction.aggregate.mockResolvedValueOnce({ _sum: { amount: null }, _count: { id: 0 } });

      await service.getReport(TENANT_ID, {});

      expect(mockPrisma.account.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT_ID }) }),
      );
      expect(mockPrisma.loan.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT_ID }) }),
      );
      expect(mockPrisma.mpesaTransaction.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT_ID }) }),
      );
    });
  });
});

// ─── AccountingController routing ─────────────────────────────────────────────

describe('AccountingController', () => {
  let controller: AccountingController;
  const mockAccountingService = {
    getLedger: jest.fn(),
    getReconciliation: jest.fn(),
    getReport: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountingController],
      providers: [
        { provide: AccountingService, useValue: mockAccountingService },
      ],
    }).compile();

    controller = module.get<AccountingController>(AccountingController);
  });

  const tenant = { id: TENANT_ID } as any;

  it('getLedgers delegates to accounting.getLedger()', async () => {
    const expected = { data: [], meta: { count: 0 } };
    mockAccountingService.getLedger.mockResolvedValueOnce(expected);

    const result = await controller.getLedgers({}, tenant);

    expect(result).toBe(expected);
    expect(mockAccountingService.getLedger).toHaveBeenCalledWith(TENANT_ID, {});
  });

  it('getReconciliation delegates to accounting.getReconciliation()', async () => {
    const expected = { settlementDate: '2026-05-08', cachedReport: null, reconPending: { count: 0, transactions: [] } };
    mockAccountingService.getReconciliation.mockResolvedValueOnce(expected);

    const result = await controller.getReconciliation({}, tenant);

    expect(result).toBe(expected);
    expect(mockAccountingService.getReconciliation).toHaveBeenCalledWith(TENANT_ID, {});
  });

  it('getReports delegates to accounting.getReport()', async () => {
    const expected = { period: {}, accountBook: [], loanBook: [], mpesaVolume: {}, generatedAt: '' };
    mockAccountingService.getReport.mockResolvedValueOnce(expected);

    const result = await controller.getReports({}, tenant);

    expect(result).toBe(expected);
    expect(mockAccountingService.getReport).toHaveBeenCalledWith(TENANT_ID, {});
  });
});

describe('AccountingService - GL & Journal Operations', () => {
  let service: AccountingService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ReconciliationService, useValue: mockRecon },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get<AccountingService>(AccountingService);
  });

  describe('getDashboardStats()', () => {
    it('returns aggregate accounting dashboard counts for one tenant', async () => {
      mockPrisma.journalEntry.count
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(12);
      mockPrisma.mpesaTransaction.count.mockResolvedValueOnce(3);
      mockPrisma.gLAccount.count.mockResolvedValueOnce(24);

      const result = await service.getDashboardStats(TENANT_ID);

      expect(result).toEqual({
        pendingApprovalCount: 5,
        unmatchedMpesaCount: 3,
        postedJournalCount: 12,
        totalGLAccounts: 24,
      });
      expect(mockPrisma.journalEntry.count).toHaveBeenNthCalledWith(1, {
        where: { tenantId: TENANT_ID, status: JournalEntryStatus.PENDING_APPROVAL },
      });
      expect(mockPrisma.mpesaTransaction.count).toHaveBeenCalledWith({
        where: {
          tenantId: TENANT_ID,
          status: TransactionStatus.RECON_PENDING,
          transactionId: null,
        },
      });
      expect(mockPrisma.gLAccount.count).toHaveBeenCalledWith({
        where: { tenantId: TENANT_ID, isActive: true },
      });
    });

    it('handles zero dashboard counts', async () => {
      mockPrisma.journalEntry.count.mockResolvedValue(0);
      mockPrisma.mpesaTransaction.count.mockResolvedValueOnce(0);
      mockPrisma.gLAccount.count.mockResolvedValueOnce(0);

      const result = await service.getDashboardStats('tenant-empty');

      expect(result).toEqual({
        pendingApprovalCount: 0,
        unmatchedMpesaCount: 0,
        postedJournalCount: 0,
        totalGLAccounts: 0,
      });
    });
  });

  describe('getGLAccounts()', () => {
    it('returns active GL accounts ordered by code', async () => {
      const accounts = [
        { id: 'acc-1', code: '1000', name: 'Cash', type: GLAccountType.ASSET, parentId: null, isSystemAccount: true, isActive: true },
        { id: 'acc-2', code: '2000', name: 'Member Savings', type: GLAccountType.LIABILITY, parentId: null, isSystemAccount: true, isActive: true },
      ];
      mockPrisma.gLAccount.findMany.mockResolvedValueOnce(accounts);

      const result = await service.getGLAccounts(TENANT_ID);

      expect(result).toEqual({ data: accounts });
      expect(mockPrisma.gLAccount.findMany).toHaveBeenCalledWith({
        where: { tenantId: TENANT_ID, isActive: true },
        orderBy: { code: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          type: true,
          parentId: true,
          isSystemAccount: true,
          isActive: true,
        },
      });
    });
  });

  describe('createJournalEntry()', () => {
    const actorId = 'user-456';
    const oneLineDto = {
      description: 'Savings deposit allocation',
      type: JournalEntryType.MANUAL,
      postings: [
        {
          debitAccountId: 'acc-cash',
          creditAccountId: 'acc-savings',
          amount: 5000,
          description: 'Member deposit',
        },
      ],
    };

    it('creates an auto-approved journal entry below the approval threshold', async () => {
      mockPrisma.gLAccount.findMany.mockResolvedValueOnce([
        { id: 'acc-cash' },
        { id: 'acc-savings' },
      ]);
      mockPrisma.journalEntry.findFirst.mockResolvedValueOnce(null);
      mockPrisma.journalEntry.create.mockResolvedValueOnce({
        id: 'je-1',
        entryNumber: 'JE-2026-000001',
        status: JournalEntryStatus.APPROVED,
        totalAmount: '5000.0000',
        postings: [{ id: 'post-1', amount: '5000.0000', description: 'Member deposit' }],
        createdBy: { id: actorId, firstName: 'A', lastName: 'User', email: 'a@test.local' },
      });

      const result = await service.createJournalEntry(TENANT_ID, oneLineDto, actorId);

      expect(result).toMatchObject({
        entryNumber: expect.stringMatching(/^JE-\d{4}-\d{6}$/),
        status: JournalEntryStatus.APPROVED,
        totalAmount: 5000,
      });
      expect(mockPrisma.journalEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            createdById: actorId,
            status: JournalEntryStatus.APPROVED,
            approvedById: actorId,
            postings: {
              create: [
                expect.objectContaining({
                  debitAccountId: 'acc-cash',
                  creditAccountId: 'acc-savings',
                  amount: '5000',
                }),
              ],
            },
          }),
        }),
      );
      expect(mockAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'JOURNAL_ENTRY.CREATED',
          entityType: 'JournalEntry',
        }),
      );
    });

    it('requires approval for journal entries at or above the approval threshold', async () => {
      const dto = { ...oneLineDto, postings: [{ ...oneLineDto.postings[0], amount: 100000 }] };
      mockPrisma.gLAccount.findMany.mockResolvedValueOnce([
        { id: 'acc-cash' },
        { id: 'acc-savings' },
      ]);
      mockPrisma.journalEntry.findFirst.mockResolvedValueOnce(null);
      mockPrisma.journalEntry.create.mockResolvedValueOnce({
        id: 'je-2',
        entryNumber: 'JE-2026-000002',
        status: JournalEntryStatus.PENDING_APPROVAL,
        totalAmount: '100000.0000',
        postings: [{ id: 'post-2', amount: '100000.0000' }],
        createdBy: { id: actorId, firstName: 'A', lastName: 'User', email: 'a@test.local' },
      });

      const result = await service.createJournalEntry(TENANT_ID, dto, actorId);

      expect(result.status).toBe(JournalEntryStatus.PENDING_APPROVAL);
      expect(mockPrisma.journalEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ approvedById: actorId }),
        }),
      );
    });

    it('rejects entries with no positive posting value', async () => {
      await expect(
        service.createJournalEntry(
          TENANT_ID,
          { ...oneLineDto, postings: [{ ...oneLineDto.postings[0], amount: 0 }] },
          actorId,
        ),
      ).rejects.toThrow('Total posting amount must be positive');
    });

    it('rejects inactive or cross-tenant GL accounts', async () => {
      mockPrisma.gLAccount.findMany.mockResolvedValueOnce([{ id: 'acc-cash' }]);

      await expect(service.createJournalEntry(TENANT_ID, oneLineDto, actorId)).rejects.toThrow(
        'GL account acc-savings not found or inactive in this tenant',
      );
    });

    it('rejects posting lines with the same debit and credit account', async () => {
      const dto = {
        ...oneLineDto,
        postings: [{ ...oneLineDto.postings[0], creditAccountId: 'acc-cash' }],
      };
      mockPrisma.gLAccount.findMany.mockResolvedValueOnce([{ id: 'acc-cash' }]);

      await expect(service.createJournalEntry(TENANT_ID, dto, actorId)).rejects.toThrow(
        'Debit and credit accounts must be different in each posting line',
      );
    });

    it('generates the next sequential journal entry number per year', async () => {
      mockPrisma.gLAccount.findMany.mockResolvedValueOnce([
        { id: 'acc-cash' },
        { id: 'acc-savings' },
      ]);
      mockPrisma.journalEntry.findFirst.mockResolvedValueOnce({ entryNumber: 'JE-2026-000005' });
      mockPrisma.journalEntry.create.mockResolvedValueOnce({
        id: 'je-6',
        entryNumber: 'JE-2026-000006',
        status: JournalEntryStatus.APPROVED,
        totalAmount: '5000.0000',
        postings: [{ id: 'post-6', amount: '5000.0000' }],
        createdBy: { id: actorId, firstName: 'A', lastName: 'User', email: 'a@test.local' },
      });

      await service.createJournalEntry(TENANT_ID, oneLineDto, actorId);

      expect(mockPrisma.journalEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ entryNumber: 'JE-2026-000006' }),
        }),
      );
    });
  });

  describe('approveJournalEntry()', () => {
    const actorId = 'approver-1';

    it('approves a pending entry and writes an audit log', async () => {
      mockPrisma.journalEntry.findFirst.mockResolvedValueOnce({
        id: 'je-1',
        status: JournalEntryStatus.PENDING_APPROVAL,
        createdById: 'maker-1',
        entryNumber: 'JE-2026-000001',
      });
      mockPrisma.journalEntry.update.mockResolvedValueOnce({
        id: 'je-1',
        entryNumber: 'JE-2026-000001',
        status: JournalEntryStatus.APPROVED,
        totalAmount: '100000.0000',
        approvedBy: { id: actorId, firstName: 'Approver', lastName: 'One' },
      });

      const result = await service.approveJournalEntry(TENANT_ID, 'je-1', actorId, 'Approved');

      expect(result).toMatchObject({ status: JournalEntryStatus.APPROVED, totalAmount: 100000 });
      expect(mockPrisma.journalEntry.update).toHaveBeenCalledWith({
        where: { id: 'je-1' },
        data: expect.objectContaining({
          status: JournalEntryStatus.APPROVED,
          approvedById: actorId,
          approvalNotes: 'Approved',
        }),
        select: expect.any(Object),
      });
      expect(mockAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'JOURNAL_ENTRY.APPROVED' }),
      );
    });

    it('rejects approval for non-pending entries', async () => {
      mockPrisma.journalEntry.findFirst.mockResolvedValueOnce({
        id: 'je-2',
        status: JournalEntryStatus.POSTED,
        createdById: 'maker-1',
        entryNumber: 'JE-2026-000002',
      });

      await expect(service.approveJournalEntry(TENANT_ID, 'je-2', actorId)).rejects.toThrow(
        'Journal entry JE-2026-000002 is POSTED, not PENDING_APPROVAL',
      );
    });

    it('prevents maker-checker self approval', async () => {
      mockPrisma.journalEntry.findFirst.mockResolvedValueOnce({
        id: 'je-3',
        status: JournalEntryStatus.PENDING_APPROVAL,
        createdById: actorId,
        entryNumber: 'JE-2026-000003',
      });

      await expect(service.approveJournalEntry(TENANT_ID, 'je-3', actorId)).rejects.toThrow(
        'Maker-checker violation',
      );
    });
  });

  describe('rejectJournalEntry()', () => {
    const actorId = 'approver-1';

    it('rejects a pending entry with notes and audit log', async () => {
      mockPrisma.journalEntry.findFirst.mockResolvedValueOnce({
        id: 'je-1',
        status: JournalEntryStatus.PENDING_APPROVAL,
        entryNumber: 'JE-2026-000001',
      });
      mockPrisma.journalEntry.update.mockResolvedValueOnce({
        id: 'je-1',
        entryNumber: 'JE-2026-000001',
        status: JournalEntryStatus.REJECTED,
        totalAmount: '100000.0000',
        rejectedBy: { id: actorId, firstName: 'Approver', lastName: 'One' },
      });

      const result = await service.rejectJournalEntry(TENANT_ID, 'je-1', actorId, 'Invalid allocation');

      expect(result).toMatchObject({ status: JournalEntryStatus.REJECTED, totalAmount: 100000 });
      expect(mockPrisma.journalEntry.update).toHaveBeenCalledWith({
        where: { id: 'je-1' },
        data: expect.objectContaining({
          status: JournalEntryStatus.REJECTED,
          rejectedById: actorId,
          approvalNotes: 'Invalid allocation',
        }),
        select: expect.any(Object),
      });
      expect(mockAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'JOURNAL_ENTRY.REJECTED' }),
      );
    });

    it('rejects rejection for non-pending entries', async () => {
      mockPrisma.journalEntry.findFirst.mockResolvedValueOnce({
        id: 'je-2',
        status: JournalEntryStatus.APPROVED,
        entryNumber: 'JE-2026-000002',
      });

      await expect(service.rejectJournalEntry(TENANT_ID, 'je-2', actorId)).rejects.toThrow(
        'Journal entry JE-2026-000002 is APPROVED, not PENDING_APPROVAL',
      );
    });
  });

  describe('getPendingApprovals()', () => {
    it('returns pending entries with display fields', async () => {
      mockPrisma.journalEntry.findMany.mockResolvedValueOnce([
        {
          id: 'je-1',
          entryNumber: 'JE-2026-000001',
          type: JournalEntryType.MANUAL,
          description: 'Large adjustment',
          totalAmount: '150000.0000',
          referenceType: 'LOAN',
          referenceId: 'loan-1',
          createdAt: new Date('2026-06-19T08:00:00Z'),
          createdBy: {
            id: 'maker-1',
            firstName: 'Maker',
            lastName: 'One',
            email: 'maker@test.local',
          },
        },
      ]);

      const result = await service.getPendingApprovals(TENANT_ID);

      expect(result).toEqual({
        items: [
          expect.objectContaining({
            id: 'je-1',
            entryNumber: 'JE-2026-000001',
            amount: 150000,
            createdBy: 'maker@test.local',
            createdByName: 'Maker One',
          }),
        ],
        total: 1,
      });
      expect(mockPrisma.journalEntry.findMany).toHaveBeenCalledWith({
        where: { tenantId: TENANT_ID, status: JournalEntryStatus.PENDING_APPROVAL },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: expect.any(Object),
      });
    });
  });

  describe('exportGL()', () => {
    it('generates CSV rows for approved or posted GL postings', async () => {
      mockPrisma.gLPosting.findMany.mockResolvedValueOnce([
        {
          id: 'post-1',
          postingDate: new Date('2026-06-19T00:00:00Z'),
          debitAccount: { code: '1000', name: 'Cash at Bank - M-Pesa', type: GLAccountType.ASSET },
          creditAccount: { code: '2000', name: 'Member Savings', type: GLAccountType.LIABILITY },
          amount: '5000.0000',
          description: 'Deposit',
          journalEntry: {
            entryNumber: 'JE-2026-000001',
            type: JournalEntryType.MANUAL,
            description: 'Deposit entry',
            createdBy: { firstName: 'A', lastName: 'User' },
          },
        },
      ]);

      const csv = await service.exportGL(TENANT_ID, {});

      expect(csv).toContain('Posting Date,Entry Number,Entry Type');
      expect(csv).toContain('2026-06-19');
      expect(csv).toContain('JE-2026-000001');
      expect(csv).toContain('1000');
      expect(csv).toContain('Cash at Bank - M-Pesa');
      expect(csv).toContain('5000.00');
    });

    it('filters export by journal entry created date range and tenant', async () => {
      mockPrisma.gLPosting.findMany.mockResolvedValueOnce([]);

      await service.exportGL(TENANT_ID, { startDate: '2026-01-01', endDate: '2026-06-30' });

      expect(mockPrisma.gLPosting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            journalEntry: {
              tenantId: TENANT_ID,
              status: { in: [JournalEntryStatus.APPROVED, JournalEntryStatus.POSTED] },
              createdAt: {
                gte: new Date('2026-01-01T00:00:00.000Z'),
                lte: new Date('2026-06-30T23:59:59.999Z'),
              },
            },
          },
        }),
      );
    });
  });

  describe('getJournalEntries()', () => {
    it('returns paginated journal entries with numeric totals', async () => {
      mockPrisma.journalEntry.findMany.mockResolvedValueOnce([
        {
          id: 'je-1',
          entryNumber: 'JE-2026-000001',
          status: JournalEntryStatus.APPROVED,
          totalAmount: '5000.0000',
          postings: [{ id: 'post-1', amount: '5000.0000' }],
        },
      ]);
      mockPrisma.journalEntry.count.mockResolvedValueOnce(1);

      const result = await service.getJournalEntries(TENANT_ID, { page: 1, limit: 20 });

      expect(result.data[0]).toMatchObject({ totalAmount: 5000 });
      expect(result.data[0].postings[0]).toMatchObject({ amount: 5000 });
      expect(result.meta).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    });

    it('filters journal entries by status, type, and search term', async () => {
      mockPrisma.journalEntry.findMany.mockResolvedValueOnce([]);
      mockPrisma.journalEntry.count.mockResolvedValueOnce(0);

      await service.getJournalEntries(TENANT_ID, {
        page: 1,
        limit: 20,
        status: JournalEntryStatus.PENDING_APPROVAL,
        type: JournalEntryType.MANUAL,
        search: 'deposit',
      });

      expect(mockPrisma.journalEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: TENANT_ID,
            status: JournalEntryStatus.PENDING_APPROVAL,
            type: JournalEntryType.MANUAL,
            OR: [
              { entryNumber: { contains: 'deposit', mode: 'insensitive' } },
              { description: { contains: 'deposit', mode: 'insensitive' } },
            ],
          }),
          skip: 0,
          take: 20,
        }),
      );
    });
  });
});

describe('AccountingService - Accounting Coverage Extensions', () => {
  let service: AccountingService;

  beforeEach(async () => {
    jest.clearAllMocks();
    (mockPrisma.$transaction as jest.Mock).mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ReconciliationService, useValue: mockRecon },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get<AccountingService>(AccountingService);
  });

  describe('getJournalEntry()', () => {
    it('returns one journal entry with numeric posting amounts', async () => {
      mockPrisma.journalEntry.findFirst.mockResolvedValueOnce({
        id: 'je-1',
        entryNumber: 'JE-2026-000001',
        type: JournalEntryType.MANUAL,
        status: JournalEntryStatus.APPROVED,
        description: 'Single entry',
        totalAmount: '7500.0000',
        referenceType: null,
        referenceId: null,
        approvalNotes: null,
        postedAt: null,
        createdAt: new Date('2026-06-19T08:00:00Z'),
        updatedAt: new Date('2026-06-19T08:00:00Z'),
        createdBy: { id: 'user-1', firstName: 'A', lastName: 'User', email: 'a@test.local' },
        approvedBy: null,
        rejectedBy: null,
        postings: [
          {
            id: 'post-1',
            amount: '7500.0000',
            description: 'Line',
            postingDate: new Date('2026-06-19T08:00:00Z'),
            createdAt: new Date('2026-06-19T08:00:00Z'),
            debitAccount: { id: 'acc-1', code: '1000', name: 'Cash', type: GLAccountType.ASSET },
            creditAccount: { id: 'acc-2', code: '2000', name: 'Savings', type: GLAccountType.LIABILITY },
          },
        ],
      });

      const result = await service.getJournalEntry(TENANT_ID, 'je-1');

      expect(result.totalAmount).toBe(7500);
      expect(result.postings[0].amount).toBe(7500);
      expect(mockPrisma.journalEntry.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'je-1', tenantId: TENANT_ID } }),
      );
    });

    it('throws when a journal entry is missing or belongs to another tenant', async () => {
      mockPrisma.journalEntry.findFirst.mockResolvedValueOnce(null);

      await expect(service.getJournalEntry(TENANT_ID, 'missing-je')).rejects.toThrow(
        'Journal entry missing-je not found in this tenant',
      );
    });
  });

  describe('getPendingReconciliation()', () => {
    it('returns paginated pending M-Pesa reconciliation rows with member display data', async () => {
      const rows = [
        {
          id: 'mpesa-1',
          reference: 'MPESA-RAW-1',
          type: MpesaTxType.STK_PUSH,
          status: TransactionStatus.RECON_PENDING,
          amount: '1250.0000',
          phoneNumber: '254700000001',
          accountReference: 'ACC-001',
          checkoutRequestId: 'ws_123',
          conversationId: null,
          mpesaReceiptNumber: null,
          resultDesc: null,
          createdAt: new Date('2026-06-19T08:00:00Z'),
          member: {
            id: 'member-1',
            memberNumber: 'MBR-001',
            user: { firstName: 'Jane', lastName: 'Doe', email: 'jane@test.local' },
          },
          transaction: null,
        },
      ];
      mockPrisma.mpesaTransaction.findMany.mockResolvedValueOnce(rows);
      mockPrisma.mpesaTransaction.count.mockResolvedValueOnce(1);
      (mockPrisma.$transaction as jest.Mock).mockImplementationOnce((ops) => Promise.all(ops));

      const result = await service.getPendingReconciliation(TENANT_ID, {
        page: 2,
        limit: 10,
        type: 'STK',
        search: 'Jane',
        startDate: '2026-06-01',
        endDate: '2026-06-30',
      });

      expect(result.data[0]).toEqual(
        expect.objectContaining({
          id: 'mpesa-1',
          mpesaReference: 'ws_123',
          type: 'STK_PUSH',
          amount: 1250,
          flagReason: 'Reconciliation mismatch requires manual review',
          member: {
            id: 'member-1',
            memberNumber: 'MBR-001',
            name: 'Jane Doe',
            email: 'jane@test.local',
          },
        }),
      );
      expect(result.meta).toMatchObject({ page: 2, limit: 10, total: 1, totalPages: 1, type: 'STK' });
      expect(mockPrisma.mpesaTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: TENANT_ID,
            status: TransactionStatus.RECON_PENDING,
            transactionId: null,
            type: MpesaTxType.STK_PUSH,
          }),
          skip: 10,
          take: 10,
        }),
      );
    });
  });

  describe('matchMpesaTransaction()', () => {
    it('posts a manual M-Pesa match atomically and writes audit metadata', async () => {
      mockPrisma.mpesaTransaction.findFirst.mockResolvedValueOnce({
        id: 'mpesa-1',
        amount: '2500.0000',
        memberId: null,
        mpesaReceiptNumber: 'RCP123',
        phoneNumber: '254700000001',
        accountReference: 'ACC-001',
      });
      mockPrisma.account.findFirst.mockResolvedValueOnce({
        id: 'account-1',
        accountNumber: 'ACC-FOSA-000001',
        member: {
          id: 'member-1',
          user: { firstName: 'Jane', lastName: 'Doe' },
        },
      });

      const tx = {
        transaction: {
          findUnique: jest.fn().mockResolvedValueOnce(null),
          create: jest.fn().mockResolvedValueOnce({ id: 'ledger-tx-1' }),
        },
        account: {
          findUnique: jest.fn().mockResolvedValueOnce({ balance: '1000.0000' }),
          update: jest.fn().mockResolvedValueOnce({}),
        },
        mpesaTransaction: {
          update: jest.fn().mockResolvedValueOnce({}),
        },
      };
      (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (callback) => callback(tx));

      const result = await service.matchMpesaTransaction(
        'mpesa-1',
        TENANT_ID,
        'account-1',
        'actor-1',
        'Matched to member',
      );

      expect(result).toEqual({
        success: true,
        transactionId: 'ledger-tx-1',
        amount: 2500,
        balanceBefore: 1000,
        balanceAfter: 3500,
        accountNumber: 'ACC-FOSA-000001',
        memberName: 'Jane Doe',
      });
      expect(tx.transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            accountId: 'account-1',
            status: TransactionStatus.COMPLETED,
            amount: '2500',
            balanceBefore: '1000',
            balanceAfter: '3500',
            processedBy: 'actor-1',
          }),
        }),
      );
      expect(tx.mpesaTransaction.update).toHaveBeenCalledWith({
        where: { id: 'mpesa-1' },
        data: expect.objectContaining({
          transactionId: 'ledger-tx-1',
          memberId: 'member-1',
          status: TransactionStatus.COMPLETED,
        }),
      });
      expect(mockAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'MPESA.MANUAL_MATCH',
          entityType: 'MpesaTransaction',
          entityId: 'mpesa-1',
        }),
      );
    });
  });
});
