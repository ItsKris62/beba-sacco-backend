import { BadRequestException } from '@nestjs/common';
import {
  ComplianceAlertSeverity,
  OutboxStatus,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { Decimal } from 'decimal.js';
import { WithdrawalReconciliationService } from './withdrawal-reconciliation.service';

const tenantId = 'tenant-1';

describe('WithdrawalReconciliationService', () => {
  const baseTx = {
    id: 'mpesa-tx-1',
    tenantId,
    transactionId: 'ledger-tx-1',
    checkoutRequestId: null,
    merchantRequestId: null,
    phoneNumber: '254712345678',
    amount: new Decimal(500),
    status: TransactionStatus.RECON_PENDING,
    resultCode: null,
    resultDesc: null,
    mpesaReceiptNumber: null,
    callbackPayload: null,
    createdAt: new Date(Date.now() - 60 * 60_000),
    updatedAt: new Date(Date.now() - 60 * 60_000),
    accountReference: null,
    conversationId: 'MWD-ledger-tx-1',
    description: null,
    loanId: null,
    loanRepaymentId: null,
    memberId: 'member-1',
    originatorConversationId: null,
    reference: 'B2C-MWD-ledger-tx-1',
    transactionDate: null,
    triggerSource: 'MEMBER',
    type: 'B2C',
    failureReason: null,
    referenceId: 'account-1',
    referenceType: 'FOSA_WITHDRAWAL',
    providerSubmissionState: 'PROVIDER_OUTCOME_UNKNOWN',
    providerSendAttemptedAt: new Date(Date.now() - 60 * 60_000),
    providerAcceptedAt: null,
    providerLastCheckedAt: null,
    reconciliationDueAt: new Date(Date.now() - 30 * 60_000),
    lastRecoveryAt: null,
    reconciliationAttemptCount: 0,
    reconciliationNextRetryAt: null,
    reconciliationLockedAt: null,
    reconciliationLockedBy: null,
    manualReviewRequired: false,
    manualReviewReason: null,
    reconciliationLastReason: null,
  };

  function build(
    overrides: {
      claimed?: Record<string, unknown>;
      after?: Record<string, unknown>;
      claimCount?: number;
      eligibleRows?: Array<Record<string, unknown>>;
      staleIntents?: Array<Record<string, unknown>>;
      providerTxForIntent?: Record<string, unknown> | null;
      debitRows?: Array<Record<string, unknown>>;
      refreshResult?: Record<string, unknown>;
    } = {},
  ) {
    const claimed = { ...baseTx, ...(overrides.claimed ?? {}) };
    const after = { ...claimed, status: TransactionStatus.COMPLETED, ...(overrides.after ?? {}) };
    const attempt = {
      id: 'attempt-1',
      attemptNumber: Number(claimed.reconciliationAttemptCount) + 1,
    };
    const txClient = {
      mpesaTransaction: {
        update: jest.fn().mockResolvedValue(after),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      mpesaWithdrawalReconciliationAttempt: {
        create: jest.fn().mockResolvedValue(attempt),
        update: jest.fn().mockResolvedValue({ ...attempt, completedAt: new Date() }),
      },
      mpesaPayoutIntent: {
        findUnique: jest.fn().mockResolvedValue({ id: 'intent-1' }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      complianceAlert: { create: jest.fn() },
    };
    const prisma = {
      mpesaTransaction: {
        updateMany: jest.fn().mockResolvedValue({ count: overrides.claimCount ?? 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValueOnce(claimed)
          .mockResolvedValueOnce(after)
          .mockResolvedValue(after),
        findUnique: jest.fn().mockResolvedValue(after),
        findMany: jest.fn().mockResolvedValue(overrides.eligibleRows ?? []),
        findFirst: jest.fn().mockResolvedValue(claimed),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      mpesaPayoutIntent: {
        findUnique: jest.fn().mockResolvedValue({ id: 'intent-1' }),
        findMany: jest.fn().mockResolvedValue(overrides.staleIntents ?? []),
      },
      mpesaWithdrawalReconciliationAttempt: {
        create: jest.fn().mockResolvedValue(attempt),
      },
      transaction: {
        findMany: jest.fn().mockResolvedValue(overrides.debitRows ?? []),
      },
      auditLog: { findUnique: jest.fn().mockResolvedValue(null) },
      complianceAlert: { create: jest.fn() },
      $transaction: jest.fn((callback: (tx: typeof txClient) => Promise<unknown>) =>
        callback(txClient),
      ),
      directClient: {
        $transaction: jest.fn((callback: (tx: typeof txClient) => Promise<unknown>) =>
          callback(txClient),
        ),
      },
    };
    prisma.mpesaTransaction.findFirst
      .mockResolvedValueOnce(claimed)
      .mockResolvedValueOnce(overrides.providerTxForIntent ?? null);

    const audit = {
      create: jest.fn().mockResolvedValue(undefined),
      createAtomic: jest.fn().mockResolvedValue(undefined),
    };
    const ledger = {
      reverseTransaction: jest.fn().mockResolvedValue({
        transaction: { id: 'reversal-tx-1' },
        journalEntry: { id: 'journal-1' },
      }),
    };
    const mpesaService = {
      refreshMwaloniB2cStatus: jest.fn().mockResolvedValue(
        overrides.refreshResult ?? {
          refreshed: true,
          terminal: true,
          status: TransactionStatus.COMPLETED,
        },
      ),
    };
    const payoutOutbox = {
      dispatchIntent: jest.fn().mockResolvedValue({ queued: true, jobId: 'job-1' }),
    };
    const config = {
      get: jest.fn((key: string, fallback: number) => {
        const values: Record<string, number> = {
          'app.mpesa.b2cPendingReconThresholdMinutes': 30,
          'app.mpesa.b2cReconRetryIntervalMinutes': 15,
          'app.mpesa.b2cMaxReconAttempts': 5,
          'app.mpesa.b2cManualReviewThresholdMinutes': 120,
          'app.mpesa.b2cStaleOutboxThresholdMinutes': 10,
          'app.mpesa.b2cReconLockTtlSeconds': 300,
        };
        return values[key] ?? fallback;
      }),
    };
    const metrics = {
      recordB2cReconciliationAttempt: jest.fn(),
      recordB2cReconciliationSuccess: jest.fn(),
      recordB2cReconciliationFailure: jest.fn(),
      recordWithdrawalCompleted: jest.fn(),
      recordWithdrawalFailed: jest.fn(),
      recordWithdrawalReversed: jest.fn(),
      setB2cStaleWithdrawals: jest.fn(),
      setB2cOldestPendingAgeSeconds: jest.fn(),
      setB2cReconOldestAgeSeconds: jest.fn(),
      setB2cDeadLetterCount: jest.fn(),
    };

    const service = new WithdrawalReconciliationService(
      prisma as never,
      audit as never,
      ledger as never,
      mpesaService as never,
      payoutOutbox as never,
      config as never,
      metrics as never,
    );
    return { service, prisma, txClient, audit, ledger, mpesaService, payoutOutbox, metrics };
  }

  it('reconciles provider success to completed without sending another payout', async () => {
    const { service, mpesaService, txClient, metrics } = build();

    const result = await service.refreshProviderStatus('mpesa-tx-1', tenantId, 'admin-1', {
      reason: 'manual status check',
    });

    expect(mpesaService.refreshMwaloniB2cStatus).toHaveBeenCalledWith('mpesa-tx-1');
    expect(txClient.mpesaWithdrawalReconciliationAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          newStatus: TransactionStatus.COMPLETED,
          reasonCode: 'PROVIDER_CONFIRMED_SUCCESS',
        }),
      }),
    );
    expect(metrics.recordWithdrawalCompleted).toHaveBeenCalledWith(tenantId, 'reconciliation');
    expect(result.status).toBe(TransactionStatus.COMPLETED);
  });

  it('skips when another worker already holds or processed the transaction', async () => {
    const { service, mpesaService } = build({ claimCount: 0 });

    const result = await service.refreshProviderStatus('mpesa-tx-1', tenantId, 'admin-1');

    expect(result).toEqual({
      mpesaTransactionId: 'mpesa-tx-1',
      action: 'SKIPPED',
      reason: 'not_eligible_or_locked',
    });
    expect(mpesaService.refreshMwaloniB2cStatus).not.toHaveBeenCalled();
  });

  it('moves no-provider-contact rows to manual review and does not query provider', async () => {
    const { service, mpesaService, txClient } = build({
      claimed: {
        providerSubmissionState: 'LOCAL_CREATED',
        providerSendAttemptedAt: null,
        conversationId: null,
      },
      after: {
        providerSubmissionState: 'LOCAL_CREATED',
        providerSendAttemptedAt: null,
        conversationId: null,
        status: TransactionStatus.RECON_PENDING,
      },
    });

    await service.refreshProviderStatus('mpesa-tx-1', tenantId, 'admin-1');

    expect(mpesaService.refreshMwaloniB2cStatus).not.toHaveBeenCalled();
    expect(txClient.mpesaTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          manualReviewRequired: true,
          reconciliationLastReason: 'PROVIDER_NOT_CONTACTED_OR_UNKNOWN_LOCAL_STATE',
        }),
      }),
    );
  });

  it('keeps provider-unavailable outcomes non-terminal and schedules retry', async () => {
    const { service, txClient, metrics, mpesaService } = build({
      refreshResult: undefined,
      after: { status: TransactionStatus.RECON_PENDING },
    });
    mpesaService.refreshMwaloniB2cStatus.mockRejectedValueOnce(new Error('provider unavailable'));

    const result = await service.refreshProviderStatus('mpesa-tx-1', tenantId, 'admin-1');

    expect(result.action).toBe('RETRY_SCHEDULED');
    expect(txClient.mpesaTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reconciliationNextRetryAt: expect.any(Date),
          reconciliationLastReason: 'PROVIDER_STATUS_UNAVAILABLE',
        }),
      }),
    );
    expect(metrics.recordB2cReconciliationFailure).toHaveBeenCalledWith(
      tenantId,
      'provider_unavailable',
    );
  });

  it('manual reversal uses LedgerService.reverseTransaction exactly once', async () => {
    const { service, ledger, txClient } = build();

    const result = await service.reverseConfirmedFailure('mpesa-tx-1', tenantId, 'admin-1', {
      reason: 'Provider confirmed failure',
      evidenceReference: 'SR-123',
    });

    expect(ledger.reverseTransaction).toHaveBeenCalledTimes(1);
    expect(ledger.reverseTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        originalTransactionId: 'ledger-tx-1',
        reversedByUserId: 'admin-1',
      }),
    );
    expect(txClient.mpesaTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: TransactionStatus.FAILED }),
      }),
    );
    expect(result.reversalTransactionId).toBe('reversal-tx-1');
  });

  it('controlled resend is blocked and audited', async () => {
    const { service, audit } = build();

    await expect(
      service.controlledResend('mpesa-tx-1', tenantId, 'admin-1', {
        reason: 'Need resend',
        evidenceReference: 'SR-456',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MPESA.WITHDRAWAL.MANUAL_RESEND_BLOCKED' }),
    );
  });

  it('stale payout intent without provider transaction is redispatched and surfaced', async () => {
    const staleIntent = {
      id: 'intent-1',
      tenantId,
      referenceType: 'FOSA_WITHDRAWAL',
      sourceTransactionId: 'ledger-tx-1',
      status: OutboxStatus.PROCESSING,
      jobId: 'job-1',
      updatedAt: new Date(Date.now() - 20 * 60_000),
    };
    const { service, payoutOutbox, audit, prisma } = build({
      eligibleRows: [],
      staleIntents: [staleIntent],
      debitRows: [],
      providerTxForIntent: null,
    });
    prisma.mpesaTransaction.findFirst.mockReset();
    prisma.mpesaTransaction.findFirst.mockResolvedValue(null);

    const result = await service.runAutomatedSweep('job-1');

    expect(payoutOutbox.dispatchIntent).toHaveBeenCalledWith('intent-1');
    expect(audit.createAtomic).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'MPESA.WITHDRAWAL.STALE_PAYOUT_INTENT_DETECTED',
      }),
    );
    expect(result.staleOutbox).toBe(1);
  });

  it('debit-without-payout anomaly is surfaced without reversing', async () => {
    const { service, audit, ledger, prisma } = build({
      eligibleRows: [],
      staleIntents: [],
      debitRows: [
        {
          id: 'ledger-orphan-1',
          tenantId,
          reference: 'MPESA_WD-tenant-1-member-1-key',
          amount: new Decimal(500),
          accountId: 'account-1',
          createdAt: new Date(Date.now() - 20 * 60_000),
          type: TransactionType.WITHDRAWAL,
          status: TransactionStatus.COMPLETED,
        },
      ],
    });
    prisma.mpesaPayoutIntent.findUnique.mockResolvedValue(null);
    prisma.mpesaTransaction.findUnique.mockResolvedValue(null);

    const result = await service.runAutomatedSweep('job-1');

    expect(result.anomalies).toBe(1);
    expect(ledger.reverseTransaction).not.toHaveBeenCalled();
    expect(audit.createAtomic).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'MPESA.WITHDRAWAL.DEBIT_WITHOUT_PAYOUT_ANOMALY',
        newValue: expect.objectContaining({ severity: ComplianceAlertSeverity.CRITICAL }),
      }),
    );
  });
});
