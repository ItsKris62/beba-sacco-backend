import { MpesaTxType, TransactionStatus } from '@prisma/client';
import { WithdrawalReconciliationProcessor } from './withdrawal-recon.processor';

describe('WithdrawalReconciliationProcessor', () => {
  const tenantId = 'tenant-1';
  const mpesaTxId = 'mpesa-tx-1';
  const ledgerTxId = 'ledger-tx-1';

  function buildProcessor(
    args: {
      pendingRows?: Array<Record<string, unknown>>;
      stuckRows?: Array<Record<string, unknown>>;
      updateManyCount?: number;
      existingAudit?: Record<string, unknown> | null;
      auditError?: Error;
    } = {},
  ) {
    const tx = {
      auditLog: {
        findUnique: jest.fn().mockResolvedValue(args.existingAudit ?? null),
      },
      mpesaTransaction: {
        updateMany: jest.fn().mockResolvedValue({ count: args.updateManyCount ?? 1 }),
      },
    };

    const pendingRows = args.pendingRows ?? [];
    const stuckRows = args.stuckRows ?? [
      {
        id: mpesaTxId,
        tenantId,
        transactionId: ledgerTxId,
        amount: { toString: () => '500.0000' },
        phoneNumber: '254712345678',
        conversationId: 'conv-1',
        referenceId: 'account-1',
        failureReason: 'B2C_TIMEOUT',
      },
    ];

    const prisma = {
      direct: {
        mpesaTransaction: {
          findMany: jest.fn().mockResolvedValueOnce(pendingRows).mockResolvedValueOnce(stuckRows),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      },
    };

    const audit = {
      createAtomic: args.auditError
        ? jest.fn().mockRejectedValue(args.auditError)
        : jest.fn().mockResolvedValue(undefined),
    };

    const config = { get: jest.fn().mockReturnValue(30) };

    const processor = new WithdrawalReconciliationProcessor(
      prisma as never,
      audit as never,
      config as never,
    );

    return { processor, prisma, tx, audit, config };
  }

  function buildJob() {
    return { id: 'job-1' } as never;
  }

  it('does nothing when there are no stale rows', async () => {
    const { processor, audit } = buildProcessor({ stuckRows: [] });

    await processor.process(buildJob());

    expect(audit.createAtomic).not.toHaveBeenCalled();
  });

  it('queries RECON_PENDING FOSA withdrawals without requiring a failed provider outcome', async () => {
    const { processor, prisma } = buildProcessor({ stuckRows: [] });

    await processor.process(buildJob());

    expect(prisma.direct.mpesaTransaction.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          referenceType: 'FOSA_WITHDRAWAL',
          status: TransactionStatus.RECON_PENDING,
          OR: expect.any(Array),
        }),
      }),
    );
  });

  it('does not auto-refund an ambiguous stuck withdrawal with a linked ledger transaction', async () => {
    const { processor, tx, audit } = buildProcessor();

    await processor.process(buildJob());

    expect(tx.mpesaTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: mpesaTxId, status: TransactionStatus.RECON_PENDING },
      data: { lastRecoveryAt: expect.any(Date) },
    });
    expect(audit.createAtomic).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'MPESA.WITHDRAWAL.RECON_MANUAL_REVIEW_REQUIRED',
        newValue: expect.objectContaining({
          status: TransactionStatus.RECON_PENDING,
          reason: 'AMBIGUOUS_PROVIDER_OUTCOME',
        }),
      }),
    );
  });

  it('flags rows with no linked ledger transaction for manual review instead of reversing', async () => {
    const { processor, audit } = buildProcessor({
      stuckRows: [
        {
          id: mpesaTxId,
          tenantId,
          transactionId: null,
          amount: { toString: () => '500.0000' },
          phoneNumber: '254712345678',
          conversationId: 'conv-1',
          referenceId: 'account-1',
          failureReason: 'B2C_FAILURE_NO_LINKED_LEDGER_TRANSACTION',
        },
      ],
    });

    await processor.process(buildJob());

    expect(audit.createAtomic).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'MPESA.WITHDRAWAL.RECON_MANUAL_REVIEW_REQUIRED',
        metadata: expect.objectContaining({ transactionId: null }),
      }),
    );
  });

  it('does not duplicate manual-review audit when the deterministic audit already exists', async () => {
    const { processor, tx, audit } = buildProcessor({ existingAudit: { id: 'audit-1' } });

    await processor.process(buildJob());

    expect(tx.mpesaTransaction.updateMany).not.toHaveBeenCalled();
    expect(audit.createAtomic).not.toHaveBeenCalled();
  });

  it('discovers historical pending B2C rows with no reconciliation deadline', async () => {
    const historicalCreatedAt = new Date(Date.now() - 60 * 60 * 1000);
    const { processor, tx, audit } = buildProcessor({
      pendingRows: [
        {
          id: 'historical-pending-1',
          tenantId,
          conversationId: 'conv-historical',
          referenceId: 'account-1',
          referenceType: 'FOSA_WITHDRAWAL',
          amount: { toString: () => '800.0000' },
          phoneNumber: '254700000001',
          createdAt: historicalCreatedAt,
          reconciliationDueAt: null,
        },
      ],
      stuckRows: [],
    });

    await processor.process(buildJob());

    expect(tx.mpesaTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'historical-pending-1', status: TransactionStatus.PENDING },
      data: expect.objectContaining({
        status: TransactionStatus.RECON_PENDING,
        failureReason: 'B2C_HISTORICAL_PENDING_WITHOUT_RECON_DEADLINE',
      }),
    });
    expect(audit.createAtomic).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'MPESA.B2C.RECONCILIATION_DEADLINE_EXPIRED',
        metadata: expect.objectContaining({ historicalNullDeadline: true }),
      }),
    );
  });

  it('queries pending B2C rows by due date or historical null deadline', async () => {
    const { processor, prisma } = buildProcessor({ stuckRows: [] });

    await processor.process(buildJob());

    expect(prisma.direct.mpesaTransaction.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          type: MpesaTxType.B2C,
          status: TransactionStatus.PENDING,
          OR: expect.arrayContaining([
            expect.objectContaining({ reconciliationDueAt: expect.any(Object) }),
            expect.objectContaining({
              reconciliationDueAt: null,
              createdAt: expect.any(Object),
            }),
          ]),
        },
      }),
    );
  });
});
