import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { TransactionStatus } from '@prisma/client';
import { FinancialService } from '../financial.service';
import { ReconciliationService } from '../reconciliation.service';
import { RedisService } from '../../../common/services/redis.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { LedgerService } from '../../accounting/ledger.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';

const TENANT_ID = 'tenant-uuid-1';
const waitForImmediate = () => new Promise((resolve) => setImmediate(resolve));

describe('Tier 4 audit logging', () => {
  describe('FinancialService accrual audit', () => {
    let mockTx: any;
    const auditQueue = { add: jest.fn().mockResolvedValue({ id: 'audit-job' }) };
    const prisma = {
      loan: { findMany: jest.fn() },
      // computeScheduleBasedDailyInterest() reads via this.prisma (not tx),
      // before the per-loan transaction opens — see financial.service.ts.
      loanRepayment: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockTx)),
    };
    const redis = { set: jest.fn().mockResolvedValue(true) };
    const ledger = {
      postInterestAccrualEntry: jest.fn().mockResolvedValue({ journalEntry: { id: 'je-interest-1' }, replayed: false }),
      postPenaltyDeductionEntry: jest.fn().mockResolvedValue({ journalEntry: { id: 'je-penalty-1' }, replayed: false }),
      postPenaltyReceivableEntry: jest.fn().mockResolvedValue({ journalEntry: { id: 'je-penalty-receivable-1' }, replayed: false }),
    };

    beforeEach(() => {
      jest.clearAllMocks();
      mockTx = {
        transaction: {
          create: jest.fn().mockResolvedValue({}),
          findFirst: jest.fn().mockResolvedValue(null),
        },
        account: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findFirst: jest.fn().mockResolvedValue({ balance: '10000.0000' }),
        },
        // debitAccountWithCas() locks the account via `SELECT ... FOR UPDATE`
        // before writing a version-guarded updateMany() — see financial.service.ts.
        $queryRaw: jest.fn().mockResolvedValue([{ balance: '10000.0000', version: 0 }]),
        loan: { update: jest.fn().mockResolvedValue({}) },
        // applyOverdueInstallmentsAndArrears() — no overdue installments in this fixture.
        loanRepayment: {
          findMany: jest.fn().mockResolvedValue([]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
    });

    it('emits INTEREST.ACCRUAL after loan update without blocking accrual', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FinancialService,
          { provide: PrismaService, useValue: prisma },
          { provide: RedisService, useValue: redis },
          { provide: LedgerService, useValue: ledger },
          { provide: getQueueToken(QUEUE_NAMES.AUDIT_LOG), useValue: auditQueue },
        ],
      }).compile();

      const service = module.get(FinancialService);
      prisma.loan.findMany.mockResolvedValueOnce([
        {
          id: 'loan-uuid-1',
          tenantId: TENANT_ID,
          outstandingBalance: { toString: () => '10000.0000' },
          principalAmount: { toString: () => '50000.0000' },
          interestRate: { toString: () => '0.1200' },
          accruedInterest: { toString: () => '25.0000' },
          lastAccrualDate: new Date('2026-05-07T00:00:00.000Z'),
          dueDate: new Date('2027-01-01T00:00:00.000Z'),
          arrearsDays: 0,
          loanProduct: { interestType: 'REDUCING_BALANCE' },
          member: {
            accounts: [{ id: 'account-uuid-1', balance: { toString: () => '10000.0000' } }],
          },
        },
      ]);

      await service.runDailyAccrual(TENANT_ID, '2026-05-08');
      expect(mockTx.loan.update).toHaveBeenCalledTimes(1);

      await waitForImmediate();
      expect(auditQueue.add).toHaveBeenCalledWith(
        'domain-event',
        expect.objectContaining({
          tenantId: TENANT_ID,
          actorId: 'SYSTEM',
          action: 'INTEREST.ACCRUAL',
          entityType: 'LOAN',
          entityId: 'loan-uuid-1',
          oldValue: { accruedInterest: '25.0000' },
          metadata: expect.objectContaining({
            dailyRate: expect.any(String),
            daysElapsed: 1,
            correlationId: expect.any(String),
          }),
        }),
        expect.objectContaining({
          jobId: 'audit.INTEREST.ACCRUAL.tenant-uuid-1.loan-uuid-1.2026-05-08',
          attempts: 1,
        }),
      );
    });
  });

  describe('ReconciliationService audit', () => {
    const auditQueue = { add: jest.fn().mockResolvedValue({ id: 'audit-job' }) };
    const prisma = {
      mpesaTransaction: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const redis = {
      set: jest.fn().mockResolvedValue(true),
      get: jest.fn(),
    };

    beforeEach(() => jest.clearAllMocks());

    async function buildService() {
      const module = await Test.createTestingModule({
        providers: [
          ReconciliationService,
          { provide: PrismaService, useValue: prisma },
          { provide: RedisService, useValue: redis },
          { provide: getQueueToken(QUEUE_NAMES.AUDIT_LOG), useValue: auditQueue },
        ],
      }).compile();

      return module.get(ReconciliationService);
    }

    it('emits RECON.FLAG_PENDING when stale PENDING is flagged', async () => {
      prisma.mpesaTransaction.findMany.mockResolvedValueOnce([
        {
          id: 'mpesa-uuid-1',
          tenantId: TENANT_ID,
          status: TransactionStatus.PENDING,
          amount: { toString: () => '1000.0000' },
          checkoutRequestId: 'ws_CO_123',
          transactionId: 'txn-uuid-1',
          mpesaReceiptNumber: null,
          createdAt: new Date('2020-01-01T00:00:00.000Z'),
          transaction: null,
        },
      ]);

      const service = await buildService();
      await service.runReconciliation(TENANT_ID, '2026-05-08');
      await waitForImmediate();

      expect(prisma.mpesaTransaction.update).toHaveBeenCalledWith({
        where: { id: 'mpesa-uuid-1' },
        data: expect.objectContaining({ status: TransactionStatus.RECON_PENDING }),
      });
      expect(auditQueue.add).toHaveBeenCalledWith(
        'domain-event',
        expect.objectContaining({
          action: 'RECON.FLAG_PENDING',
          entityType: 'TRANSACTION',
          entityId: 'txn-uuid-1',
          oldValue: { status: TransactionStatus.PENDING },
          newValue: { status: TransactionStatus.RECON_PENDING },
        }),
        expect.objectContaining({
          jobId: 'audit.RECON.FLAG_PENDING.tenant-uuid-1.mpesa-uuid-1.2026-05-08',
        }),
      );
    });

    it('emits idempotent RECON.COMPLETE with summary job id per tenant/date', async () => {
      prisma.mpesaTransaction.findMany.mockResolvedValueOnce([]);

      const service = await buildService();
      await service.runReconciliation(TENANT_ID, '2026-05-08');
      await waitForImmediate();

      expect(auditQueue.add).toHaveBeenCalledWith(
        'domain-event',
        expect.objectContaining({
          action: 'RECON.COMPLETE',
          entityId: '2026-05-08',
          metadata: expect.objectContaining({
            matchedCount: 0,
            pendingCount: 0,
            flaggedTotal: 0,
            correlationId: expect.any(String),
          }),
        }),
        expect.objectContaining({
          jobId: 'audit.RECON.COMPLETE.tenant-uuid-1.2026-05-08',
        }),
      );
    });
  });
});
