import { Decimal } from 'decimal.js';
import { LoanStatus, TransactionStatus, TransactionType } from '@prisma/client';
import { Queue } from 'bullmq';
import { LoanRepaymentService } from './loan-repayment.service';
import { ExecuteGuarantorDebitJobPayload } from '../queue/queue.constants';

type MockFn = jest.Mock;

describe('LoanRepaymentService', () => {
  const tenantId = 'tenant-1';
  const loanId = 'loan-1';
  const accountId = 'account-1';

  function buildService(args: {
    existingTransaction?: { loanId: string; amount: Decimal } | null;
    paymentAmount: Decimal;
    outstanding?: string;
    accruedInterest?: string;
    arrearsAmount?: string;
    accountBalance?: string;
  }) {
    const tx = {
      transaction: {
        findFirst: jest.fn().mockResolvedValue(args.existingTransaction ?? null),
        create: jest.fn().mockImplementation((input: { data: { type: TransactionType; amount: string } }) =>
          Promise.resolve({ id: `tx-${input.data.type}-${input.data.amount}`, amount: new Decimal(input.data.amount), loanId }),
        ),
      },
      loan: {
        findFirst: jest.fn().mockResolvedValue({ id: loanId, loanNumber: 'LN-1', outstandingBalance: new Decimal('0'), status: LoanStatus.ACTIVE }),
        update: jest.fn().mockResolvedValue({}),
      },
      account: {
        update: jest.fn().mockResolvedValue({}),
      },
      mpesaTransaction: {
        update: jest.fn().mockResolvedValue({}),
      },
      loanRepayment: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'schedule-1',
            amountPaid: new Decimal('1500'),
            penaltyDue: new Decimal('100'),
            interestDue: new Decimal('400'),
            principalDue: new Decimal('1000'),
            penaltyPaid: new Decimal('0'),
            interestPaid: new Decimal('0'),
            principalPaid: new Decimal('0'),
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: loanId,
            loanNumber: 'LN-1',
            memberId: 'member-1',
            status: LoanStatus.ACTIVE,
            outstandingBalance: args.outstanding ?? '1000',
            accruedInterest: args.accruedInterest ?? '400',
            arrearsAmount: args.arrearsAmount ?? '100',
            totalRepaid: '0',
          },
        ])
        .mockResolvedValueOnce([{ id: accountId, balance: args.accountBalance ?? '200' }]),
    };

    const prisma = {
      direct: {
        $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      },
    };
    const audit = { create: jest.fn().mockResolvedValue({}) };
    const accountBalance = new Decimal(args.accountBalance ?? '200');
    const ledger = {
      postLoanRepaymentLegEntry: jest.fn().mockResolvedValue({ journalEntry: { id: 'je-leg-1' }, replayed: false }),
      postEntry: jest.fn().mockImplementation(async (params: { amount: Decimal }) => ({
        transaction: {
          id: 'txn-overpay-1',
          balanceBefore: accountBalance.toString(),
          balanceAfter: accountBalance.plus(params.amount).toDecimalPlaces(4).toString(),
        },
        journalEntry: { id: 'je-overpay-1' },
      })),
    };
    const queue = { getDelayed: jest.fn().mockResolvedValue([]) };
    const service = new LoanRepaymentService(
      prisma as unknown as ConstructorParameters<typeof LoanRepaymentService>[0],
      audit as unknown as ConstructorParameters<typeof LoanRepaymentService>[1],
      ledger as unknown as ConstructorParameters<typeof LoanRepaymentService>[2],
      queue as unknown as Queue<ExecuteGuarantorDebitJobPayload>,
    );
    return { service, tx, audit, ledger, queue };
  }

  it('allocates exact repayment through penalty, interest, then principal', async () => {
    const { service, tx, ledger } = buildService({ paymentAmount: new Decimal('1500') });

    const result = await service.processRepayment({
      tenantId,
      amount: new Decimal('1500'),
      reference: 'MPESA-R1',
      processedBy: 'MPESA_SYSTEM',
      loanId,
    });

    expect(result.allocatedToPenalty.toFixed(2)).toBe('100.00');
    expect(result.allocatedToInterest.toFixed(2)).toBe('400.00');
    expect(result.allocatedToPrincipal.toFixed(2)).toBe('1000.00');
    expect(result.status).toBe(LoanStatus.FULLY_PAID);
    expect(tx.loanRepayment.update as MockFn).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        penaltyPaid: '100',
        interestPaid: '400',
        principalPaid: '1000',
        // amountPaid must equal the sum of the three *Paid legs above (Phase 3 fix).
        amountPaid: '1500',
        status: 'PAID',
      }),
    }));

    // Every leg posts its GL-only entry (Cash vs Income/Receivable) via LedgerService.
    expect(ledger.postLoanRepaymentLegEntry).toHaveBeenCalledTimes(3);
    expect(ledger.postLoanRepaymentLegEntry).toHaveBeenCalledWith(expect.objectContaining({ leg: 'PENALTY' }));
    expect(ledger.postLoanRepaymentLegEntry).toHaveBeenCalledWith(expect.objectContaining({ leg: 'INTEREST' }));
    expect(ledger.postLoanRepaymentLegEntry).toHaveBeenCalledWith(expect.objectContaining({ leg: 'PRINCIPAL' }));
    // No overpayment on this exact-amount repayment.
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  it('routes overpayment to the member FOSA account as a deposit via LedgerService.postEntry()', async () => {
    const { service, ledger } = buildService({ paymentAmount: new Decimal('2000') });

    const result = await service.processRepayment({
      tenantId,
      amount: new Decimal('2000'),
      reference: 'MPESA-R2',
      processedBy: 'MPESA_SYSTEM',
      loanId,
    });

    expect(result.overpaymentToFosa.toFixed(2)).toBe('500.00');
    expect(ledger.postEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        journalType: 'DEPOSIT',
        accountId,
        direction: 'CREDIT',
        reference: 'MPESA-R2-OVERPAY',
        loanId,
      }),
    );
    // The three waterfall legs still post their GL-only entries (penalty/interest/
    // principal fully covered before the remainder becomes overpayment).
    expect(ledger.postLoanRepaymentLegEntry).toHaveBeenCalledTimes(3);
  });

  it('returns existing transaction result without duplicating ledger entries', async () => {
    const { service, tx, ledger } = buildService({
      paymentAmount: new Decimal('1500'),
      existingTransaction: { loanId, amount: new Decimal('1500') },
    });

    await service.processRepayment({
      tenantId,
      amount: new Decimal('1500'),
      reference: 'MPESA-R3',
      processedBy: 'MPESA_SYSTEM',
      loanId,
    });

    expect(tx.transaction.create as MockFn).not.toHaveBeenCalled();
    expect(ledger.postLoanRepaymentLegEntry).not.toHaveBeenCalled();
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  it('marks an installment PARTIAL and keeps amountPaid in lockstep with the sub-fields when underpaid', async () => {
    // Only enough to cover the penalty and part of the interest — dueTotal for
    // the fixture installment is 100 (penalty) + 400 (interest) + 1000 (principal) = 1500.
    const { service, tx } = buildService({
      paymentAmount: new Decimal('250'),
      outstanding: '1000',
      accruedInterest: '400',
      arrearsAmount: '100',
    });

    const result = await service.processRepayment({
      tenantId,
      amount: new Decimal('250'),
      reference: 'MPESA-R4',
      processedBy: 'MPESA_SYSTEM',
      loanId,
    });

    // 250 -> 100 to penalty, 150 to interest, 0 to principal.
    expect(result.allocatedToPenalty.toFixed(2)).toBe('100.00');
    expect(result.allocatedToInterest.toFixed(2)).toBe('150.00');
    expect(result.allocatedToPrincipal.toFixed(2)).toBe('0.00');
    expect(result.status).toBe(LoanStatus.ACTIVE);

    expect(tx.loanRepayment.update as MockFn).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        penaltyPaid: '100',
        interestPaid: '150',
        principalPaid: '0',
        amountPaid: '250', // 100 + 150 + 0 — always the sum of the three *Paid legs
        status: 'PARTIAL',
        paidAt: null,
      }),
    }));
  });

  it('cancels delayed guarantor debit jobs after a curing repayment', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const { service, queue } = buildService({ paymentAmount: new Decimal('1500') });
    (queue.getDelayed as MockFn).mockResolvedValueOnce([
      {
        name: 'guarantor-debit-execute',
        id: 'debit-1',
        data: { tenantId, loanId },
        remove,
      },
    ]);

    await service.cancelDelayedGuarantorDebit(tenantId, loanId);

    expect(remove).toHaveBeenCalledTimes(1);
  });
});
