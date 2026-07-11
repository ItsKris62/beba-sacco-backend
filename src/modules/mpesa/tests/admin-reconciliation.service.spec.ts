import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { TransactionStatus } from '@prisma/client';
import { AdminReconciliationService } from '../admin-reconciliation.service';
import { ReconciliationRecoveryAction } from '../dto/reconciliation-recover.dto';

const TENANT_ID = 'tenant-1';

describe('AdminReconciliationService', () => {
  function buildService(overrides: {
    stuckRows?: Array<Record<string, unknown>>;
    lateSuccessLogs?: Array<Record<string, unknown>>;
    resolvedLogs?: Array<Record<string, unknown>>;
    mpesaTransaction?: Record<string, unknown> | null;
    txMock?: Record<string, unknown>;
  } = {}) {
    const auditLogFindMany = jest
      .fn()
      .mockImplementationOnce(async () => overrides.lateSuccessLogs ?? [])
      .mockImplementationOnce(async () => overrides.resolvedLogs ?? []);

    const prisma = {
      mpesaTransaction: {
        findMany: jest.fn().mockResolvedValue(overrides.stuckRows ?? []),
        findFirst: jest.fn().mockResolvedValue(
          overrides.mpesaTransaction === undefined
            ? {
                id: 'mtx-1',
                tenantId: TENANT_ID,
                memberId: 'member-1',
                status: TransactionStatus.RECON_PENDING,
                failureReason: null,
                transactionId: 'ledger-tx-1',
                amount: '500.0000',
                phoneNumber: '254712345678',
                referenceType: 'FOSA_WITHDRAWAL',
              }
            : overrides.mpesaTransaction,
        ),
      },
      auditLog: { findMany: auditLogFindMany },
      account: { findFirst: jest.fn().mockResolvedValue({ id: 'account-1' }) },
      $transaction: jest.fn((callback: (tx: unknown) => Promise<unknown>) =>
        callback(
          overrides.txMock ?? {
            transaction: {
              findFirst: jest
                .fn()
                .mockResolvedValueOnce({ id: 'ledger-tx-1', reference: 'MPESA_WD-t-m-key' })
                .mockResolvedValueOnce({ id: 'reversal-tx-1', reference: 'MPESA_WD-t-m-key-REVERSAL' }),
            },
            account: {
              findFirst: jest
                .fn()
                .mockResolvedValue({ balance: '10000', lockedBalance: '0', frozenSavings: '0' }),
            },
          },
        ),
      ),
    };

    const ledger = {
      reverseTransaction: jest
        .fn()
        .mockResolvedValue({ transaction: { id: 're-reversal-1' }, journalEntry: { id: 'je-1' } }),
      postEntry: jest.fn().mockResolvedValue({ transaction: { id: 'redebit-tx-1' } }),
    };

    const audit = {
      create: jest.fn().mockResolvedValue(undefined),
      createAtomic: jest.fn().mockResolvedValue(undefined),
    };

    const mpesaService = {
      executeB2cDisbursement: jest
        .fn()
        .mockResolvedValue({ conversationId: 'conv-new-1', mpesaTxId: 'mtx-new-1' }),
    };

    const service = new AdminReconciliationService(prisma as any, ledger as any, audit as any, mpesaService as any);
    return { service, prisma, ledger, audit, mpesaService };
  }

  // ── listPending ──────────────────────────────────────────────────────────

  describe('listPending', () => {
    it('includes RECON_PENDING FOSA_WITHDRAWAL rows as STUCK_RECON_PENDING', async () => {
      const { service } = buildService({
        stuckRows: [
          {
            id: 'mtx-a',
            amount: '500.0000',
            phoneNumber: '254712345678',
            status: TransactionStatus.RECON_PENDING,
            transactionId: null,
            updatedAt: new Date('2026-07-01T00:00:00Z'),
          },
        ],
      });

      const result = await service.listPending(TENANT_ID);

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        mpesaTransactionId: 'mtx-a',
        caseType: 'STUCK_RECON_PENDING',
        hasLinkedLedgerTransaction: false,
      });
    });

    it('includes an unresolved LATE_SUCCESS audit log as LATE_SUCCESS_DOUBLE_CREDIT', async () => {
      const { service, prisma } = buildService({
        stuckRows: [],
        lateSuccessLogs: [{ entityId: 'mtx-b', timestamp: new Date('2026-07-01T00:00:00Z'), newValue: {} }],
        resolvedLogs: [],
      });
      (prisma.mpesaTransaction.findMany as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: 'mtx-b',
          amount: '800.0000',
          phoneNumber: '254700000000',
          status: TransactionStatus.FAILED,
          transactionId: 'ledger-tx-b',
          updatedAt: new Date('2026-07-01T00:05:00Z'),
        },
      ]);

      const result = await service.listPending(TENANT_ID);

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        mpesaTransactionId: 'mtx-b',
        caseType: 'LATE_SUCCESS_DOUBLE_CREDIT',
      });
    });

    it('excludes a LATE_SUCCESS case that already has a MANUALLY_RECOVERED audit entry', async () => {
      const { service, prisma } = buildService({
        stuckRows: [],
        lateSuccessLogs: [{ entityId: 'mtx-c', timestamp: new Date(), newValue: {} }],
        resolvedLogs: [{ entityId: 'mtx-c' }],
      });

      const result = await service.listPending(TENANT_ID);

      expect(result.data).toEqual([]);
      // Resolved before we ever look up the underlying MpesaTransaction row.
      expect(prisma.mpesaTransaction.findMany).toHaveBeenCalledTimes(1);
    });

    it('paginates the merged, chronologically-sorted case list', async () => {
      const { service } = buildService({
        stuckRows: [
          { id: 'a', amount: '1', phoneNumber: 'x', status: TransactionStatus.RECON_PENDING, transactionId: null, updatedAt: new Date('2026-07-01T00:00:00Z') },
          { id: 'b', amount: '1', phoneNumber: 'x', status: TransactionStatus.RECON_PENDING, transactionId: null, updatedAt: new Date('2026-07-02T00:00:00Z') },
          { id: 'c', amount: '1', phoneNumber: 'x', status: TransactionStatus.RECON_PENDING, transactionId: null, updatedAt: new Date('2026-07-03T00:00:00Z') },
        ],
      });

      const page1 = await service.listPending(TENANT_ID, { limit: 2, offset: 0 });
      expect(page1.total).toBe(3);
      expect(page1.data.map((c) => c.mpesaTransactionId)).toEqual(['a', 'b']);

      const page2 = await service.listPending(TENANT_ID, { limit: 2, offset: 2 });
      expect(page2.data.map((c) => c.mpesaTransactionId)).toEqual(['c']);
    });
  });

  // ── recover: REVERSE_AUTO_REFUND ────────────────────────────────────────

  describe('recover — REVERSE_AUTO_REFUND', () => {
    it('reverses the auto-refund and records a MANUALLY_RECOVERED audit entry', async () => {
      const { service, ledger, audit } = buildService({
        mpesaTransaction: {
          id: 'mtx-1',
          tenantId: TENANT_ID,
          memberId: 'member-1',
          status: TransactionStatus.FAILED,
          failureReason: 'RECONCILIATION_TIMEOUT_AUTO_REFUNDED',
          transactionId: 'ledger-tx-1',
          amount: '500.0000',
          phoneNumber: '254712345678',
          referenceType: 'FOSA_WITHDRAWAL',
        },
      });

      const result = await service.recover(
        'mtx-1',
        { action: ReconciliationRecoveryAction.REVERSE_AUTO_REFUND, notes: 'Confirmed with Safaricom SR-1' },
        TENANT_ID,
        'admin-1',
        '127.0.0.1',
      );

      expect(ledger.reverseTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_ID, originalTransactionId: 'reversal-tx-1' }),
      );
      expect(audit.createAtomic).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'MPESA.WITHDRAWAL.MANUALLY_RECOVERED' }),
      );
      expect(result.action).toBe('REVERSE_AUTO_REFUND');
    });

    it('rejects when the transaction was never auto-refunded', async () => {
      const { service, ledger } = buildService({
        mpesaTransaction: {
          id: 'mtx-1',
          tenantId: TENANT_ID,
          memberId: 'member-1',
          status: TransactionStatus.RECON_PENDING,
          failureReason: null,
          transactionId: 'ledger-tx-1',
          amount: '500.0000',
          phoneNumber: '254712345678',
          referenceType: 'FOSA_WITHDRAWAL',
        },
      });

      await expect(
        service.recover(
          'mtx-1',
          { action: ReconciliationRecoveryAction.REVERSE_AUTO_REFUND, notes: 'not applicable here' },
          TENANT_ID,
          'admin-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(ledger.reverseTransaction).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the reversal transaction cannot be found (ledger inconsistent)', async () => {
      const { service } = buildService({
        mpesaTransaction: {
          id: 'mtx-1',
          tenantId: TENANT_ID,
          memberId: 'member-1',
          status: TransactionStatus.FAILED,
          failureReason: 'RECONCILIATION_TIMEOUT_AUTO_REFUNDED',
          transactionId: 'ledger-tx-1',
          amount: '500.0000',
          phoneNumber: '254712345678',
          referenceType: 'FOSA_WITHDRAWAL',
        },
        txMock: {
          transaction: {
            findFirst: jest
              .fn()
              .mockResolvedValueOnce({ id: 'ledger-tx-1', reference: 'MPESA_WD-t-m-key' })
              .mockResolvedValueOnce(null),
          },
        },
      });

      await expect(
        service.recover(
          'mtx-1',
          { action: ReconciliationRecoveryAction.REVERSE_AUTO_REFUND, notes: 'investigating ledger gap' },
          TENANT_ID,
          'admin-1',
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── recover: MANUAL_B2C_PAYOUT ──────────────────────────────────────────

  describe('recover — MANUAL_B2C_PAYOUT', () => {
    it('pays out directly (no re-debit) when the withdrawal was never auto-refunded', async () => {
      const { service, ledger, mpesaService } = buildService({
        mpesaTransaction: {
          id: 'mtx-1',
          tenantId: TENANT_ID,
          memberId: 'member-1',
          status: TransactionStatus.RECON_PENDING,
          failureReason: null,
          transactionId: 'ledger-tx-1',
          amount: '500.0000',
          phoneNumber: '254712345678',
          referenceType: 'FOSA_WITHDRAWAL',
        },
      });

      const result = await service.recover(
        'mtx-1',
        { action: ReconciliationRecoveryAction.MANUAL_B2C_PAYOUT, notes: 'Safaricom confirmed payout never sent' },
        TENANT_ID,
        'admin-1',
      );

      expect(ledger.postEntry).not.toHaveBeenCalled();
      expect(mpesaService.executeB2cDisbursement).toHaveBeenCalledWith(
        'account-1',
        'FOSA_WITHDRAWAL',
        TENANT_ID,
        '254712345678',
        500,
        'admin-1',
        'ledger-tx-1',
      );
      expect(result.action).toBe('MANUAL_B2C_PAYOUT');
    });

    it('re-debits FOSA before paying out when the withdrawal was already auto-refunded', async () => {
      const { service, ledger, mpesaService } = buildService({
        mpesaTransaction: {
          id: 'mtx-1',
          tenantId: TENANT_ID,
          memberId: 'member-1',
          status: TransactionStatus.FAILED,
          failureReason: 'RECONCILIATION_TIMEOUT_AUTO_REFUNDED',
          transactionId: 'ledger-tx-1',
          amount: '500.0000',
          phoneNumber: '254712345678',
          referenceType: 'FOSA_WITHDRAWAL',
        },
      });

      await service.recover(
        'mtx-1',
        { action: ReconciliationRecoveryAction.MANUAL_B2C_PAYOUT, notes: 'Member confirmed no payout received' },
        TENANT_ID,
        'admin-1',
      );

      expect(ledger.postEntry).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_ID, direction: 'DEBIT', accountId: 'account-1' }),
      );
      expect(mpesaService.executeB2cDisbursement).toHaveBeenCalledWith(
        'account-1',
        'FOSA_WITHDRAWAL',
        TENANT_ID,
        '254712345678',
        500,
        'admin-1',
        'redebit-tx-1',
      );
    });

    it('rejects when the withdrawal already completed successfully (double-pay guard)', async () => {
      const { service, mpesaService } = buildService({
        mpesaTransaction: {
          id: 'mtx-1',
          tenantId: TENANT_ID,
          memberId: 'member-1',
          status: TransactionStatus.COMPLETED,
          failureReason: null,
          transactionId: 'ledger-tx-1',
          amount: '500.0000',
          phoneNumber: '254712345678',
          referenceType: 'FOSA_WITHDRAWAL',
        },
      });

      await expect(
        service.recover(
          'mtx-1',
          { action: ReconciliationRecoveryAction.MANUAL_B2C_PAYOUT, notes: 'attempted payout on completed txn' },
          TENANT_ID,
          'admin-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mpesaService.executeB2cDisbursement).not.toHaveBeenCalled();
    });

    it('rejects the re-debit when FOSA available balance is insufficient', async () => {
      const { service, mpesaService } = buildService({
        mpesaTransaction: {
          id: 'mtx-1',
          tenantId: TENANT_ID,
          memberId: 'member-1',
          status: TransactionStatus.FAILED,
          failureReason: 'RECONCILIATION_TIMEOUT_AUTO_REFUNDED',
          transactionId: 'ledger-tx-1',
          amount: '500.0000',
          phoneNumber: '254712345678',
          referenceType: 'FOSA_WITHDRAWAL',
        },
        txMock: {
          account: {
            findFirst: jest.fn().mockResolvedValue({ balance: '100', lockedBalance: '0', frozenSavings: '0' }),
          },
        },
      });

      await expect(
        service.recover(
          'mtx-1',
          { action: ReconciliationRecoveryAction.MANUAL_B2C_PAYOUT, notes: 'balance already spent elsewhere' },
          TENANT_ID,
          'admin-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mpesaService.executeB2cDisbursement).not.toHaveBeenCalled();
    });
  });

  // ── recover: not found ──────────────────────────────────────────────────

  it('throws NotFoundException when the M-Pesa transaction does not exist for this tenant', async () => {
    const { service } = buildService({ mpesaTransaction: null });

    await expect(
      service.recover(
        'ghost-tx',
        { action: ReconciliationRecoveryAction.MANUAL_B2C_PAYOUT, notes: 'looking for a transaction that is gone' },
        TENANT_ID,
        'admin-1',
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
