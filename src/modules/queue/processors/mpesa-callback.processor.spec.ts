import { MpesaCallbackProcessor } from './mpesa-callback.processor';
import { PrismaService } from '../../../prisma/prisma.service';
import { JournalEntryType, LoanStatus, TransactionStatus, MpesaTxType, MpesaTriggerSource } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { Queue } from 'bullmq';
import { Job } from 'bullmq';
import type { AuditService } from '../../audit/audit.service';
import type { LoanRepaymentService } from '../../loans/loan-repayment.service';
import type { LedgerService } from '../../accounting/ledger.service';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const C2B_PAYLOAD = {
  TransactionType: 'Pay Bill',
  TransID: 'TXN_C2B_001',
  TransTime: '20240101120000',
  TransAmount: '1000.00',
  BusinessShortCode: '174379',
  BillRefNumber: 'ACC-0001',
  MSISDN: '254712000001',
};

function makeJob(payload: Record<string, unknown>, type = 'C2B'): Job {
  return {
    id: 'job-1',
    data: { callbackPayload: payload, callbackType: type },
  } as unknown as Job;
}

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeAccount(tenantId: string) {
  return { id: `acct-${tenantId}`, balance: '10000', memberId: `mem-${tenantId}`, tenantId };
}

function makePrisma(overrides: Partial<{
  txFindFirst: jest.Mock;
  accountFindMany: jest.Mock;
  txCreate: jest.Mock;
  accountFindFirst: jest.Mock;
  transactionCreate: jest.Mock;
  transactionUpdate: jest.Mock;
  accountUpdate: jest.Mock;
  loanFindUnique: jest.Mock;
  loanUpdate: jest.Mock;
  auditLogCreate: jest.Mock;
}>= {}) {
  return {
    mpesaTransaction: {
      findFirst: overrides.txFindFirst ?? jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: overrides.txCreate ?? jest.fn().mockResolvedValue({ id: 'mpesa-tx-1' }),
      update: overrides.transactionUpdate ?? jest.fn().mockResolvedValue({}),
    },
    account: {
      findMany: overrides.accountFindMany ?? jest.fn().mockResolvedValue([]),
      findFirst: overrides.accountFindFirst ?? jest.fn().mockResolvedValue(null),
      update: overrides.accountUpdate ?? jest.fn().mockResolvedValue({}),
    },
    transaction: {
      create: overrides.transactionCreate ?? jest.fn().mockResolvedValue({ id: 'ledger-1' }),
    },
    auditLog: {
      create: overrides.auditLogCreate ?? jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({
      mpesaTransaction: {
        create: overrides.txCreate ?? jest.fn().mockResolvedValue({ id: 'mpesa-tx-1' }),
        update: overrides.transactionUpdate ?? jest.fn().mockResolvedValue({}),
      },
      account: {
        update: overrides.accountUpdate ?? jest.fn().mockResolvedValue({}),
        findFirst: overrides.accountFindFirst ?? jest.fn().mockResolvedValue(null),
      },
      loan: {
        findUnique: overrides.loanFindUnique ?? jest.fn().mockResolvedValue(null),
        update: overrides.loanUpdate ?? jest.fn().mockResolvedValue({}),
      },
      transaction: {
        // postLedgerEntry calls findFirst to check for duplicate references (Layer 3)
        findFirst: jest.fn().mockResolvedValue(null),
        create: overrides.transactionCreate ?? jest.fn().mockResolvedValue({ id: 'ledger-1' }),
      },
      auditLog: {
        create: overrides.auditLogCreate ?? jest.fn().mockResolvedValue({}),
      },
    })),
  } as unknown as PrismaService;
}

const mockDlq = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;
const mockAudit = { create: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
const mockCache = { invalidateTenantDashboard: jest.fn().mockResolvedValue(undefined) };
const mockLoanRepayment = { processMpesaRepayment: jest.fn().mockResolvedValue(undefined) } as unknown as LoanRepaymentService;
const mockLedger = {
  postEntry: jest.fn().mockResolvedValue({
    transaction: { id: 'ledger-tx-1', balanceBefore: '10000', balanceAfter: '11000' },
    journalEntry: { id: 'je-1' },
  }),
} as unknown as LedgerService;

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('MpesaCallbackProcessor – C2B tenant isolation [C-4]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Duplicate guard ────────────────────────────────────────────────────

  it('skips processing when the TransID already exists (idempotency)', async () => {
    const existingTx = { id: 'old-tx', mpesaReceiptNumber: 'TXN_C2B_001' };
    const accountFindMany = jest.fn();
    const prisma = makePrisma({
      txFindFirst: jest.fn().mockResolvedValue(existingTx),
      accountFindMany,
    });

    const processor = new MpesaCallbackProcessor(prisma, mockAudit, mockLoanRepayment, mockCache as never, mockLedger, mockDlq);
    await processor.process(makeJob(C2B_PAYLOAD as never));

    expect(accountFindMany).not.toHaveBeenCalled();
  });

  // ── No account found ───────────────────────────────────────────────────

  it('creates a FAILED MpesaTransaction with resultCode 9999 when no account matches BillRefNumber', async () => {
    const txCreate = jest.fn().mockResolvedValue({ id: 'mpesa-tx-fail' });
    const prisma = makePrisma({
      accountFindMany: jest.fn().mockResolvedValue([]),
      txCreate,
    });

    const processor = new MpesaCallbackProcessor(prisma, mockAudit, mockLoanRepayment, mockCache as never, mockLedger, mockDlq);
    await processor.process(makeJob(C2B_PAYLOAD as never));

    expect(txCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'UNRESOLVED',
          status: TransactionStatus.FAILED,
          resultCode: 9999,
          mpesaReceiptNumber: 'TXN_C2B_001',
        }),
      }),
    );
  });

  // ── Single account (happy path) ────────────────────────────────────────

  it('processes the payment normally when exactly one account matches', async () => {
    const account = makeAccount('tenant-A');
    const txCreate = jest.fn().mockResolvedValue({ id: 'mpesa-tx-ok', tenantId: 'tenant-A' });
    const prisma = makePrisma({
      accountFindMany: jest.fn().mockResolvedValue([account]),
      txCreate,
    });

    const processor = new MpesaCallbackProcessor(prisma, mockAudit, mockLoanRepayment, mockCache as never, mockLedger, mockDlq);
    await processor.process(makeJob(C2B_PAYLOAD as never));

    expect(txCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-A',
          mpesaReceiptNumber: 'TXN_C2B_001',
          type: MpesaTxType.C2B,
          status: TransactionStatus.PENDING,
        }),
      }),
    );
  });

  // ── Cross-tenant collision [C-4] ───────────────────────────────────────

  it('[C-4] creates a FAILED MpesaTransaction with resultCode 9998 on cross-tenant account collision', async () => {
    const accountA = makeAccount('tenant-A');
    const accountB = makeAccount('tenant-B');
    const txCreate = jest.fn().mockResolvedValue({ id: 'mpesa-tx-collision' });
    const prisma = makePrisma({
      accountFindMany: jest.fn().mockResolvedValue([accountA, accountB]),
      txCreate,
    });

    const processor = new MpesaCallbackProcessor(prisma, mockAudit, mockLoanRepayment, mockCache as never, mockLedger, mockDlq);
    await processor.process(makeJob(C2B_PAYLOAD as never));

    expect(txCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'UNRESOLVED',
          status: TransactionStatus.FAILED,
          resultCode: 9998,
          mpesaReceiptNumber: 'TXN_C2B_001',
        }),
      }),
    );
  });

  it('[C-4] does NOT credit any tenant account on a collision (never calls account.update)', async () => {
    const accountA = makeAccount('tenant-A');
    const accountB = makeAccount('tenant-B');
    const accountUpdate = jest.fn();
    const prisma = makePrisma({
      accountFindMany: jest.fn().mockResolvedValue([accountA, accountB]),
      accountUpdate,
    });

    const processor = new MpesaCallbackProcessor(prisma, mockAudit, mockLoanRepayment, mockCache as never, mockLedger, mockDlq);
    await processor.process(makeJob(C2B_PAYLOAD as never));

    expect(accountUpdate).not.toHaveBeenCalled();
  });

  it('[C-4] uses findMany (not findFirst) for account lookup to detect collisions', async () => {
    const accountFindMany = jest.fn().mockResolvedValue([]);
    const accountFindFirst = jest.fn();
    const prisma = makePrisma({ accountFindMany, accountFindFirst });

    const processor = new MpesaCallbackProcessor(prisma, mockAudit, mockLoanRepayment, mockCache as never, mockLedger, mockDlq);
    await processor.process(makeJob(C2B_PAYLOAD as never));

    expect(accountFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ accountNumber: 'ACC-0001' }),
      }),
    );
    expect(accountFindFirst).not.toHaveBeenCalled();
  });

  it('routes B2C loan disbursement through LedgerService.postEntry without direct balance writes', async () => {
    const transactionCreate = jest.fn().mockResolvedValue({ id: 'direct-ledger-tx' });
    const accountUpdate = jest.fn().mockResolvedValue({});
    const transactionUpdate = jest.fn().mockResolvedValue({});
    const loanUpdate = jest.fn().mockResolvedValue({});
    const prisma = makePrisma({
      transactionCreate,
      accountUpdate,
      transactionUpdate,
      accountFindFirst: jest.fn().mockResolvedValue({ id: 'fosa-1' }),
      loanFindUnique: jest.fn().mockResolvedValue({
        id: 'loan-1',
        memberId: 'member-1',
        status: LoanStatus.APPROVED,
      }),
      loanUpdate,
    });

    const processor = new MpesaCallbackProcessor(prisma, mockAudit, mockLoanRepayment, mockCache as never, mockLedger, mockDlq);
    await (processor as unknown as {
      postDisbursementLedger(params: {
        tenantId: string;
        loanId: string;
        memberId?: string;
        amount: Decimal;
        receipt: string;
        mpesaTxId: string;
        rawPayload: Record<string, never>;
        resultCode: number;
        resultDesc: string;
        transactionDate: Date;
      }): Promise<void>;
    }).postDisbursementLedger({
      tenantId: 'tenant-1',
      loanId: 'loan-1',
      memberId: 'member-1',
      amount: new Decimal(2500),
      receipt: 'RCT123',
      mpesaTxId: 'mpesa-tx-1',
      rawPayload: {},
      resultCode: 0,
      resultDesc: 'Success',
      transactionDate: new Date('2026-07-10T09:00:00.000Z'),
    });

    expect(mockLedger.postEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        reference: 'MPESA-B2C-RCT123',
        journalType: JournalEntryType.LOAN_DISBURSEMENT,
        accountId: 'fosa-1',
        amount: expect.any(Decimal),
        direction: 'CREDIT',
        description: 'M-Pesa B2C disbursement – RCT123',
        loanId: 'loan-1',
        tx: expect.any(Object),
      }),
    );
    expect(transactionCreate).not.toHaveBeenCalled();
    expect(accountUpdate).not.toHaveBeenCalled();
    expect(loanUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'loan-1' },
        data: expect.objectContaining({ status: LoanStatus.DISBURSED }),
      }),
    );
    expect(transactionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'mpesa-tx-1' },
        data: expect.objectContaining({ transactionId: 'ledger-tx-1' }),
      }),
    );
  });
});
