import { MpesaCallbackProcessor } from './mpesa-callback.processor';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionStatus, MpesaTxType, MpesaTriggerSource } from '@prisma/client';
import { Queue } from 'bullmq';
import { Job } from 'bullmq';

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
        findFirst: jest.fn().mockResolvedValue(null),
      },
      transaction: {
        // postLedgerEntry calls findUnique to check for duplicate references (Layer 3)
        findUnique: jest.fn().mockResolvedValue(null),
        create: overrides.transactionCreate ?? jest.fn().mockResolvedValue({ id: 'ledger-1' }),
      },
      auditLog: {
        create: overrides.auditLogCreate ?? jest.fn().mockResolvedValue({}),
      },
    })),
  } as unknown as PrismaService;
}

const mockDlq = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('MpesaCallbackProcessor – C2B tenant isolation [C-4]', () => {

  // ── Duplicate guard ────────────────────────────────────────────────────

  it('skips processing when the TransID already exists (idempotency)', async () => {
    const existingTx = { id: 'old-tx', mpesaReceiptNumber: 'TXN_C2B_001' };
    const accountFindMany = jest.fn();
    const prisma = makePrisma({
      txFindFirst: jest.fn().mockResolvedValue(existingTx),
      accountFindMany,
    });

    const processor = new MpesaCallbackProcessor(prisma, mockDlq);
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

    const processor = new MpesaCallbackProcessor(prisma, mockDlq);
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

    const processor = new MpesaCallbackProcessor(prisma, mockDlq);
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

    const processor = new MpesaCallbackProcessor(prisma, mockDlq);
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

    const processor = new MpesaCallbackProcessor(prisma, mockDlq);
    await processor.process(makeJob(C2B_PAYLOAD as never));

    expect(accountUpdate).not.toHaveBeenCalled();
  });

  it('[C-4] uses findMany (not findFirst) for account lookup to detect collisions', async () => {
    const accountFindMany = jest.fn().mockResolvedValue([]);
    const accountFindFirst = jest.fn();
    const prisma = makePrisma({ accountFindMany, accountFindFirst });

    const processor = new MpesaCallbackProcessor(prisma, mockDlq);
    await processor.process(makeJob(C2B_PAYLOAD as never));

    expect(accountFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ accountNumber: 'ACC-0001' }),
      }),
    );
    expect(accountFindFirst).not.toHaveBeenCalled();
  });
});
