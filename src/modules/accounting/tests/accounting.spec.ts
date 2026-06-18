import { Test, TestingModule } from '@nestjs/testing';
import { TransactionStatus } from '@prisma/client';
import { AccountingService } from '../accounting.service';
import { AccountingController } from '../accounting.controller';
import { PrismaService } from '../../../prisma/prisma.service';
import { ReconciliationService } from '../../financial/reconciliation.service';
import { AuditService } from '../../audit/audit.service';

// ─── Stubs ────────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-uuid-1';

const mockPrisma = {
  transaction: { findMany: jest.fn() },
  account: { groupBy: jest.fn() },
  loan: { groupBy: jest.fn() },
  mpesaTransaction: {
    count: jest.fn(),
    findMany: jest.fn(),
    aggregate: jest.fn(),
  },
};

const mockRecon = {
  getLatestReport: jest.fn(),
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

      const result = await service.getLedger(TENANT_ID, {});

      expect(result.data).toHaveLength(1);
      expect(result.meta).toMatchObject({ count: 1 });
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
