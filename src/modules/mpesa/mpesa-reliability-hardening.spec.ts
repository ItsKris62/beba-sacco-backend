import { ConfigService } from '@nestjs/config';
import { OutboxStatus } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { MpesaPayoutOutboxService } from './mpesa-payout-outbox.service';
import { MpesaService } from './mpesa.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RedisService } from '../../common/services/redis.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { DarajaClientService } from './daraja-client.service';
import { LoanRepaymentService } from '../loans/loan-repayment.service';

describe('M-Pesa reliability hardening', () => {
  it('keeps a payout intent recoverable when BullMQ enqueue fails', async () => {
    const intent = {
      id: 'intent-1',
      tenantId: 'tenant-1',
      dispatchKey: 'FOSA_WITHDRAWAL:tenant-1:txn-1',
      jobId: 'fosa-withdraw-txn-1',
      referenceType: 'FOSA_WITHDRAWAL',
      referenceId: 'account-1',
      sourceTransactionId: 'txn-1',
      memberId: 'member-1',
      accountId: 'account-1',
      phoneNumber: '254712345678',
      amount: new Decimal(500),
      triggeredBy: 'user-1',
      provider: null,
      status: OutboxStatus.PENDING,
      attempts: 0,
      lastError: null,
      nextRetryAt: null,
      dispatchedAt: null,
      deadLetteredAt: null,
      mpesaTransactionId: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = {
      mpesaPayoutIntent: {
        findUnique: jest.fn().mockResolvedValue(intent),
        update: jest.fn().mockResolvedValue(intent),
      },
    } as unknown as PrismaService;
    const queue = { add: jest.fn().mockRejectedValue(new Error('redis down')) };
    const service = new MpesaPayoutOutboxService(
      prisma,
      { createAtomic: jest.fn() } as unknown as AuditService,
      queue as never,
    );

    const result = await service.dispatchIntent('intent-1');

    expect(result).toEqual({ queued: false, jobId: 'fosa-withdraw-txn-1' });
    expect(prisma.mpesaPayoutIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'intent-1' },
        data: expect.objectContaining({
          status: OutboxStatus.FAILED,
          lastError: 'redis down',
        }),
      }),
    );
  });

  it('does not enqueue a payout intent that is already delivered', async () => {
    const prisma = {
      mpesaPayoutIntent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'intent-1',
          jobId: 'fosa-withdraw-txn-1',
          status: OutboxStatus.DELIVERED,
        }),
      },
    } as unknown as PrismaService;
    const queue = { add: jest.fn() };
    const service = new MpesaPayoutOutboxService(
      prisma,
      { createAtomic: jest.fn() } as unknown as AuditService,
      queue as never,
    );

    await expect(service.dispatchIntent('intent-1')).resolves.toEqual({
      queued: false,
      jobId: 'fosa-withdraw-txn-1',
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('persists callback inbox before returning even when callback queue dispatch fails', async () => {
    const tx = {
      mpesaTransaction: {
        findUnique: jest.fn().mockResolvedValue({ id: 'mpesa-1', tenantId: 'tenant-1' }),
        update: jest.fn().mockResolvedValue({ id: 'mpesa-1' }),
      },
      mpesaCallbackInbox: {
        upsert: jest.fn().mockResolvedValue({
          id: 'inbox-1',
          mpesaTransactionId: 'mpesa-1',
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      mpesaCallbackInbox: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'inbox-1',
          tenantId: 'tenant-1',
          callbackType: 'STK_PUSH',
          providerUniqueId: 'checkout-1',
          correlationId: 'corr-1',
          mpesaTransactionId: 'mpesa-1',
          status: OutboxStatus.PENDING,
        }),
        update: jest.fn().mockResolvedValue({ id: 'inbox-1' }),
      },
    } as unknown as PrismaService;
    const callbackQueue = { add: jest.fn().mockRejectedValue(new Error('redis down')) };
    const service = new MpesaService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma,
      { set: jest.fn().mockResolvedValue(true) } as unknown as RedisService,
      {} as unknown as IdempotencyService,
      {} as unknown as DarajaClientService,
      { create: jest.fn(), createAtomic: jest.fn() } as unknown as AuditService,
      {} as unknown as LoanRepaymentService,
      callbackQueue as never,
      { add: jest.fn() } as never,
      { add: jest.fn() } as never,
      { add: jest.fn() } as never,
    );

    await expect(
      service.enqueueCallback(
        {
          Body: {
            stkCallback: {
              MerchantRequestID: 'merchant-1',
              CheckoutRequestID: 'checkout-1',
              ResultCode: 0,
              ResultDesc: 'Accepted',
            },
          },
        },
        'STK_PUSH',
        'checkout-1',
        'tenant-1',
        'corr-1',
      ),
    ).resolves.toBeUndefined();

    expect(tx.mpesaCallbackInbox.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uniqueKey: 'MPESA:tenant-1:STK_PUSH:checkout-1' },
        create: expect.objectContaining({
          tenantId: 'tenant-1',
          mpesaTransactionId: 'mpesa-1',
        }),
      }),
    );
    expect(prisma.mpesaCallbackInbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inbox-1' },
        data: expect.objectContaining({
          status: OutboxStatus.FAILED,
          lastError: 'redis down',
        }),
      }),
    );
  });

  it('does not persist or ACK when callback DB persistence fails', async () => {
    const prisma = {
      $transaction: jest.fn().mockRejectedValue(new Error('database unavailable')),
      mpesaCallbackInbox: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    } as unknown as PrismaService;
    const callbackQueue = { add: jest.fn() };
    const service = new MpesaService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma,
      { set: jest.fn().mockResolvedValue(true) } as unknown as RedisService,
      {} as unknown as IdempotencyService,
      {} as unknown as DarajaClientService,
      { create: jest.fn(), createAtomic: jest.fn() } as unknown as AuditService,
      {} as unknown as LoanRepaymentService,
      callbackQueue as never,
      { add: jest.fn() } as never,
      { add: jest.fn() } as never,
      { add: jest.fn() } as never,
    );

    await expect(
      service.enqueueCallback(
        {
          Body: {
            stkCallback: {
              MerchantRequestID: 'merchant-1',
              CheckoutRequestID: 'checkout-1',
              ResultCode: 0,
              ResultDesc: 'Accepted',
            },
          },
        },
        'STK_PUSH',
        'checkout-1',
        'tenant-1',
      ),
    ).rejects.toThrow('database unavailable');
    expect(callbackQueue.add).not.toHaveBeenCalled();
  });

  it('marks a payout intent dead-letter only once', async () => {
    const intent = {
      id: 'intent-1',
      tenantId: 'tenant-1',
      dispatchKey: 'FOSA_WITHDRAWAL:tenant-1:txn-1',
      jobId: 'fosa-withdraw-txn-1',
      referenceType: 'FOSA_WITHDRAWAL',
      referenceId: 'account-1',
      sourceTransactionId: 'txn-1',
      memberId: 'member-1',
      accountId: 'account-1',
      phoneNumber: '254712345678',
      amount: new Decimal(500),
      triggeredBy: 'user-1',
      provider: null,
      status: OutboxStatus.FAILED,
      attempts: 2,
      lastError: 'redis down',
      nextRetryAt: null,
      dispatchedAt: null,
      deadLetteredAt: null,
      mpesaTransactionId: 'mpesa-1',
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const tx = {
      auditLog: { findUnique: jest.fn().mockResolvedValue(null) },
      mpesaPayoutIntent: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(intent)
          .mockResolvedValueOnce({ ...intent, status: OutboxStatus.DEAD_LETTER }),
        update: jest.fn().mockResolvedValue({ ...intent, status: OutboxStatus.DEAD_LETTER }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as PrismaService;
    const audit = { createAtomic: jest.fn().mockResolvedValue(undefined) };
    const service = new MpesaPayoutOutboxService(
      prisma,
      audit as unknown as AuditService,
      { add: jest.fn() } as never,
    );
    const payload = {
      payoutIntentId: 'intent-1',
      referenceType: 'FOSA_WITHDRAWAL' as const,
      referenceId: 'account-1',
      tenantId: 'tenant-1',
      phone: '254712345678',
      amount: 500,
      triggeredBy: 'user-1',
      sourceTransactionId: 'txn-1',
    };

    await service.markDeadLetter({
      payoutIntentId: 'intent-1',
      sourceTransactionId: 'txn-1',
      tenantId: 'tenant-1',
      queueJobId: 'job-1',
      retryCount: 3,
      lastError: 'redis down',
      payload,
    });
    await service.markDeadLetter({
      payoutIntentId: 'intent-1',
      sourceTransactionId: 'txn-1',
      tenantId: 'tenant-1',
      queueJobId: 'job-1',
      retryCount: 3,
      lastError: 'redis down',
      payload,
    });

    expect(tx.mpesaPayoutIntent.update).toHaveBeenCalledTimes(1);
    expect(audit.createAtomic).toHaveBeenCalledTimes(1);
    expect(audit.createAtomic).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'MPESA.DISBURSEMENT.DLQ',
        requestId: 'audit.MPESA.DISBURSEMENT.DLQ.tenant-1.intent-1',
      }),
    );
  });
});
