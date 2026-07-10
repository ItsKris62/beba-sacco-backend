import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Decimal } from 'decimal.js';
import { LoanRecoveryService } from './loan-recovery.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { LedgerService } from '../accounting/ledger.service';
import { QUEUE_NAMES } from '../queue/queue.constants';

// ─── Transaction mock ─────────────────────────────────────────────────────────
//
// recoverFromGuarantorsLocked() uses (prisma.direct ?? prisma).$transaction(async (tx) => {
//   tx.loan.findFirst            × 1 (loan + accepted, un-released guarantors)
//   tx.account.findMany          × 1 (allocateRecovery — guarantor accounts)
//   tx.transaction.findFirst     × 1 per guarantor (existing-reference dedup check)
//   tx.$queryRaw                 × 1 per guarantor (SELECT ... FOR UPDATE)
//   tx.account.updateMany        × 1 per guarantor (CAS version check)
//   tx.loanGuarantor.updateMany  × 1 per guarantor (recoveredAmount / holdReleasedAt)
//   tx.transaction.create        × 1 per guarantor
//   tx.loan.updateMany           × 1 (outstandingBalance decrement)
//   tx.auditLog.findFirst/create × 1 per guarantor (hash-chained audit log)
// }), and calls ledger.postGuarantorForfeitureEntry() for the GL leg.

type TxClient = {
  loan: { findFirst: jest.Mock; updateMany: jest.Mock };
  account: { findMany: jest.Mock; updateMany: jest.Mock };
  transaction: { findFirst: jest.Mock; create: jest.Mock };
  loanGuarantor: { updateMany: jest.Mock };
  auditLog: { findFirst: jest.Mock; create: jest.Mock };
  $queryRaw: jest.Mock;
};

const TENANT_ID = 'tenant-uuid-1';
const LOAN_ID = 'loan-uuid-1';
const ACTOR_ID = 'actor-uuid-1';
const GUARANTOR_ID = 'guarantor-uuid-1';
const GUARANTOR_MEMBER_ID = 'member-uuid-1';
const ACCOUNT_ID = 'account-uuid-1';

function buildTxClient(overrides: Partial<TxClient> = {}): TxClient {
  return {
    loan: {
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    account: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    transaction: {
      findFirst: jest.fn().mockResolvedValue(null), // no existing recovery — not a replay
      create: jest.fn().mockResolvedValue({ id: 'txn-1' }),
    },
    loanGuarantor: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    $queryRaw: jest.fn(),
    ...overrides,
  };
}

function buildLoan(guaranteedAmount: string, recoveredAmount: string, outstandingBalance = '100000.0000') {
  return {
    id: LOAN_ID,
    loanNumber: 'LN-001',
    outstandingBalance: { toString: () => outstandingBalance },
    loanProduct: { requiredAccountType: 'FOSA' },
    guarantors: [
      {
        id: GUARANTOR_ID,
        memberId: GUARANTOR_MEMBER_ID,
        guaranteedAmount: { toString: () => guaranteedAmount },
        recoveredAmount: { toString: () => recoveredAmount },
      },
    ],
  };
}

function buildAccount(balance: string, frozenSavings: string) {
  return { id: ACCOUNT_ID, memberId: GUARANTOR_MEMBER_ID, balance: { toString: () => balance }, frozenSavings: { toString: () => frozenSavings } };
}

let mockTx: TxClient;

const mockPrisma = {
  direct: undefined as unknown,
  $transaction: jest.fn(async (cb: (tx: TxClient) => Promise<unknown>) => cb(mockTx)),
};

const mockRedis = {
  acquireLock: jest.fn().mockResolvedValue('lock-token-1'),
  releaseLock: jest.fn().mockResolvedValue(undefined),
};

const mockLedger = {
  postGuarantorForfeitureEntry: jest.fn().mockResolvedValue({ journalEntry: { id: 'je-1' }, replayed: false }),
};

const mockGuarantorRecoveryQueue = { add: jest.fn() };

describe('LoanRecoveryService.recoverFromGuarantors() — holdReleasedAt bookkeeping', () => {
  let service: LoanRecoveryService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTx = buildTxClient();
    mockPrisma.direct = undefined;
    mockRedis.acquireLock.mockResolvedValue('lock-token-1');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoanRecoveryService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: LedgerService, useValue: mockLedger },
        { provide: getQueueToken(QUEUE_NAMES.GUARANTOR_RECOVERY), useValue: mockGuarantorRecoveryQueue },
      ],
    }).compile();

    service = module.get<LoanRecoveryService>(LoanRecoveryService);
  });

  it('sets holdReleasedAt when the recovery fully exhausts the guarantor\'s frozen savings', async () => {
    // guaranteedAmount=5000, recoveredAmount=0 → full 5000 capacity; account has
    // exactly 5000 frozen — the recovery deducts all of it, leaving remainingFrozenSavings = 0.
    mockTx.loan.findFirst.mockResolvedValue(buildLoan('5000.0000', '0.0000'));
    mockTx.account.findMany.mockResolvedValue([buildAccount('5000.0000', '5000.0000')]);
    mockTx.$queryRaw.mockResolvedValue([{ balance: '5000.0000', frozenSavings: '5000.0000', version: 0 }]);

    await service.recoverFromGuarantors(LOAN_ID, TENANT_ID, new Decimal('5000'), ACTOR_ID);

    expect(mockTx.loanGuarantor.updateMany).toHaveBeenCalledTimes(1);
    const guarantorUpdateCall = mockTx.loanGuarantor.updateMany.mock.calls[0][0];
    expect(guarantorUpdateCall.data.holdReleasedAt).toBeInstanceOf(Date);
    expect(guarantorUpdateCall.data.recoveryDate).toBeInstanceOf(Date);
    expect(guarantorUpdateCall.data.holdReleasedAt).toEqual(guarantorUpdateCall.data.recoveryDate);
  });

  it('omits holdReleasedAt when the recovery only partially depletes frozen savings', async () => {
    // guaranteedAmount=5000, recoveredAmount=0 → capacity 5000, but the loan's
    // outstanding balance (1000) is far below the guarantor's hold, so allocateRecovery's
    // proportional-share logic only asks for a small deduction relative to a much larger
    // account balance/frozenSavings — leaving frozenSavings > 0 after the deduction.
    mockTx.loan.findFirst.mockResolvedValue(buildLoan('5000.0000', '0.0000', '1000.0000'));
    mockTx.account.findMany.mockResolvedValue([buildAccount('5000.0000', '5000.0000')]);
    mockTx.$queryRaw.mockResolvedValue([{ balance: '5000.0000', frozenSavings: '5000.0000', version: 0 }]);

    await service.recoverFromGuarantors(LOAN_ID, TENANT_ID, new Decimal('1000'), ACTOR_ID);

    expect(mockTx.loanGuarantor.updateMany).toHaveBeenCalledTimes(1);
    const guarantorUpdateCall = mockTx.loanGuarantor.updateMany.mock.calls[0][0];
    expect(guarantorUpdateCall.data.holdReleasedAt).toBeUndefined();
    expect(guarantorUpdateCall.data.recoveredAmount).toEqual({ increment: expect.any(String) });
  });
});
