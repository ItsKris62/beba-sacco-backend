import { TransactionStatus } from '@prisma/client';
import { WithdrawalReconciliationProcessor } from './withdrawal-recon.processor';

describe('WithdrawalReconciliationProcessor', () => {
  const tenantId = 'tenant-1';
  const mpesaTxId = 'mpesa-tx-1';
  const ledgerTxId = 'ledger-tx-1';

  function buildProcessor(args: {
    stuckRows?: Array<Record<string, unknown>>;
    updateManyCount?: number;
    reverseTransactionError?: Error;
  } = {}) {
    const tx = {
      mpesaTransaction: {
        updateMany: jest.fn().mockResolvedValue({ count: args.updateManyCount ?? 1 }),
      },
    };

    const prisma = {
      direct: {
        mpesaTransaction: {
          findMany: jest.fn().mockResolvedValue(
            args.stuckRows ?? [
              {
                id: mpesaTxId,
                tenantId,
                transactionId: ledgerTxId,
                amount: '500.0000',
                phoneNumber: '254712345678',
                conversationId: 'conv-1',
              },
            ],
          ),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      },
    };

    const ledger = {
      reverseTransaction: args.reverseTransactionError
        ? jest.fn().mockRejectedValue(args.reverseTransactionError)
        : jest.fn().mockResolvedValue({ transaction: { id: 'reversal-1' }, journalEntry: { id: 'je-1' } }),
    };

    const audit = {
      create: jest.fn().mockResolvedValue(undefined),
      createAtomic: jest.fn().mockResolvedValue(undefined),
    };

    const config = { get: jest.fn().mockReturnValue(30) };

    const processor = new WithdrawalReconciliationProcessor(
      prisma as any,
      ledger as any,
      audit as any,
      config as any,
    );

    return { processor, prisma, tx, ledger, audit, config };
  }

  function buildJob() {
    return { id: 'job-1' } as any;
  }

  it('does nothing when there are no stuck rows', async () => {
    const { processor, ledger, audit } = buildProcessor({ stuckRows: [] });

    await processor.process(buildJob());

    expect(ledger.reverseTransaction).not.toHaveBeenCalled();
    expect(audit.createAtomic).not.toHaveBeenCalled();
  });

  it('queries only RECON_PENDING FOSA_WITHDRAWAL rows older than the grace window', async () => {
    const { processor, prisma } = buildProcessor({ stuckRows: [] });

    await processor.process(buildJob());

    expect(prisma.direct.mpesaTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          referenceType: 'FOSA_WITHDRAWAL',
          status: TransactionStatus.RECON_PENDING,
          updatedAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      }),
    );
  });

  it('auto-refunds a stuck withdrawal that still has a linked ledger transaction', async () => {
    const { processor, tx, ledger, audit } = buildProcessor();

    await processor.process(buildJob());

    expect(tx.mpesaTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: mpesaTxId, status: TransactionStatus.RECON_PENDING },
      data: expect.objectContaining({
        status: TransactionStatus.FAILED,
        failureReason: 'RECONCILIATION_TIMEOUT_AUTO_REFUNDED',
      }),
    });
    expect(ledger.reverseTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        originalTransactionId: ledgerTxId,
      }),
    );
    expect(audit.createAtomic).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'MPESA.WITHDRAWAL.RECONCILIATION_AUTO_REFUND' }),
    );
  });

  it('flags rows with no linked ledger transaction for manual review instead of reversing', async () => {
    const { processor, ledger, audit } = buildProcessor({
      stuckRows: [
        {
          id: mpesaTxId,
          tenantId,
          transactionId: null,
          amount: '500.0000',
          phoneNumber: '254712345678',
          conversationId: 'conv-1',
        },
      ],
    });

    await processor.process(buildJob());

    expect(ledger.reverseTransaction).not.toHaveBeenCalled();
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MPESA.WITHDRAWAL.RECON_MANUAL_REVIEW_REQUIRED' }),
    );
  });

  it('skips a row without reversing when a concurrent writer already claimed it', async () => {
    const { processor, ledger, audit } = buildProcessor({ updateManyCount: 0 });

    await processor.process(buildJob());

    expect(ledger.reverseTransaction).not.toHaveBeenCalled();
    expect(audit.createAtomic).not.toHaveBeenCalled();
  });

  it('logs and continues (does not throw) when the ledger reversal fails', async () => {
    const { processor, audit } = buildProcessor({ reverseTransactionError: new Error('DB unavailable') });

    await expect(processor.process(buildJob())).resolves.toBeUndefined();
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MPESA.WITHDRAWAL.RECONCILIATION_AUTO_REFUND_FAILED' }),
    );
  });

  it('processes multiple stuck rows independently — one failure does not stop the rest', async () => {
    const rows = [
      { id: 'mpesa-tx-a', tenantId, transactionId: 'ledger-a', amount: '100', phoneNumber: '254700000001', conversationId: 'conv-a' },
      { id: 'mpesa-tx-b', tenantId, transactionId: 'ledger-b', amount: '200', phoneNumber: '254700000002', conversationId: 'conv-b' },
    ];
    const { processor, ledger } = buildProcessor({ stuckRows: rows });
    (ledger.reverseTransaction as jest.Mock)
      .mockRejectedValueOnce(new Error('transient failure for row A'))
      .mockResolvedValueOnce({ transaction: { id: 'reversal-b' }, journalEntry: { id: 'je-b' } });

    await processor.process(buildJob());

    expect(ledger.reverseTransaction).toHaveBeenCalledTimes(2);
  });
});
