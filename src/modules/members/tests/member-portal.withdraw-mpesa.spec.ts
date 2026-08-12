import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { MemberPortalService } from '../member-portal.service';

function hashPayload(phone: string, amount: number): string {
  return createHash('sha256').update(JSON.stringify({ phone, amount })).digest('hex');
}

describe('MemberPortalService.withdrawMpesa — idempotency', () => {
  const tenantId = 'tenant-1';
  const userId = 'user-1';
  const memberId = 'member-1';
  const accountId = 'account-1';
  const phone = '254712345678';

  function buildService(
    args: {
      fosaBalance?: string;
      lockedBalance?: string;
      frozenSavings?: string;
      idempotencyStatus?: 'NEW' | 'PROCESSING' | 'COMPLETED';
      cachedResult?: unknown;
      noFosaAccount?: boolean;
      memberPhone?: string | null;
      memberPhoneNumber?: string | null;
      phoneVerified?: boolean;
    } = {},
  ) {
    const tx = {
      account: {
        findFirst: jest.fn().mockResolvedValue(
          args.noFosaAccount
            ? null
            : {
                id: accountId,
                balance: args.fosaBalance ?? '10000',
                lockedBalance: args.lockedBalance ?? '0',
                frozenSavings: args.frozenSavings ?? '0',
                accountNumber: 'ACC-FOSA-000001',
              },
        ),
      },
      mpesaPayoutIntent: {
        upsert: jest.fn().mockResolvedValue({ id: 'intent-1' }),
      },
    };

    const prisma = {
      member: {
        findFirst: jest.fn().mockResolvedValue({
          id: memberId,
          memberNumber: 'M-001',
          user: {
            firstName: 'Jane',
            lastName: 'Member',
            email: 'jane@example.test',
            phone: args.memberPhone ?? phone,
            phoneNumber: args.memberPhoneNumber ?? phone,
            phoneVerified: args.phoneVerified ?? true,
          },
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };

    const audit = {
      create: jest.fn().mockResolvedValue(undefined),
      createAtomic: jest.fn().mockResolvedValue(undefined),
    };

    const ledger = {
      postEntry: jest
        .fn()
        .mockImplementation(async (params: { amount: { toString(): string } }) => ({
          transaction: { id: `txn-${params.amount.toString()}` },
        })),
    };

    const idempotency = {
      checkAndReserve: jest
        .fn()
        .mockResolvedValue({ status: args.idempotencyStatus ?? 'NEW', result: args.cachedResult }),
      complete: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };

    const payoutOutbox = {
      dispatchIntent: jest.fn().mockResolvedValue({ queued: true, jobId: 'fosa-withdraw-txn-500' }),
    };

    const service = new MemberPortalService(
      prisma as any,
      audit as any,
      {} as any, // mpesaService — unused by withdrawMpesa
      {} as any, // loansService
      {} as any, // storage
      {} as any, // accountsService
      ledger as any,
      idempotency as any,
      payoutOutbox as any,
    );

    return { service, prisma, tx, audit, ledger, idempotency, payoutOutbox };
  }

  // ── Missing key ─────────────────────────────────────────────────────────

  it('rejects a request with no idempotency key', async () => {
    const { service } = buildService();

    await expect(
      service.withdrawMpesa(userId, phone, 500, tenantId, '127.0.0.1', undefined),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.withdrawMpesa(userId, phone, 500, tenantId, '127.0.0.1', '   '),
    ).rejects.toThrow(BadRequestException);
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it('debits the FOSA account exactly once for a fresh idempotency key using the verified server-side phone', async () => {
    const { service, ledger, idempotency, payoutOutbox, tx, audit } = buildService({
      idempotencyStatus: 'NEW',
    });

    const result = await service.withdrawMpesa(
      userId,
      undefined,
      500,
      tenantId,
      '127.0.0.1',
      'key-1',
    );

    expect(ledger.postEntry).toHaveBeenCalledTimes(1);
    expect(ledger.postEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        accountId,
        direction: 'DEBIT',
        reference: `MPESA_WD-${tenantId}-${memberId}-key-1`,
      }),
    );
    expect(audit.createAtomic).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        tenantId,
        action: 'MPESA.WITHDRAW.INITIATED',
        entityId: 'txn-500',
      }),
    );
    expect(tx.mpesaPayoutIntent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dispatchKey: `FOSA_WITHDRAWAL:${tenantId}:txn-500` },
        create: expect.objectContaining({
          sourceTransactionId: 'txn-500',
          referenceId: accountId,
          phoneNumber: phone,
          amount: '500',
        }),
      }),
    );
    expect(payoutOutbox.dispatchIntent).toHaveBeenCalledWith('intent-1');
    expect(idempotency.complete).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      message: 'Withdrawal initiated successfully',
      transactionId: 'txn-500',
    });
  });

  it('rejects a request phone that differs from the verified server-side phone before debit', async () => {
    const { service, ledger, payoutOutbox, audit } = buildService();

    await expect(
      service.withdrawMpesa(userId, '254700000000', 500, tenantId, '127.0.0.1', 'key-1'),
    ).rejects.toThrow(BadRequestException);

    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(payoutOutbox.dispatchIntent).not.toHaveBeenCalled();
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'MPESA.WITHDRAW.REJECTED',
        newValue: expect.objectContaining({ reasonCode: 'REQUEST_PHONE_MISMATCH' }),
      }),
    );
  });

  it('rejects withdrawal when the member phone is not verified before debit', async () => {
    const { service, ledger, tx } = buildService({ phoneVerified: false });

    await expect(
      service.withdrawMpesa(userId, phone, 500, tenantId, '127.0.0.1', 'key-1'),
    ).rejects.toThrow(BadRequestException);

    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(tx.mpesaPayoutIntent.upsert).not.toHaveBeenCalled();
  });

  // ── Exact replay: same key, same payload ──────────────────────────────────

  it('returns the cached response without re-debiting on an exact replay', async () => {
    const cachedResponse = {
      message: 'Withdrawal initiated successfully',
      transactionId: 'txn-500',
    };
    const payloadHash = hashPayload(phone, 500);

    const { service, ledger, prisma, payoutOutbox } = buildService({
      idempotencyStatus: 'COMPLETED',
      cachedResult: { payloadHash, response: cachedResponse },
    });

    const result = await service.withdrawMpesa(userId, phone, 500, tenantId, '127.0.0.1', 'key-1');

    expect(result).toEqual(cachedResponse);
    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(payoutOutbox.dispatchIntent).not.toHaveBeenCalled();
    // Replay short-circuits before even resolving the member profile or FOSA account.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ── Same key, different payload ────────────────────────────────────────────

  it('rejects a replay that reuses the key with a different amount', async () => {
    const payloadHashForOriginalAmount = hashPayload(phone, 500);

    const { service, ledger, payoutOutbox } = buildService({
      idempotencyStatus: 'COMPLETED',
      cachedResult: {
        payloadHash: payloadHashForOriginalAmount,
        response: { message: 'Withdrawal initiated successfully', transactionId: 'txn-500' },
      },
    });

    // Same key, but amount changed from 500 -> 5000.
    await expect(
      service.withdrawMpesa(userId, phone, 5000, tenantId, '127.0.0.1', 'key-1'),
    ).rejects.toThrow(BadRequestException);
    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(payoutOutbox.dispatchIntent).not.toHaveBeenCalled();
  });

  it('rejects a fresh request that supplies a different phone number', async () => {
    const payloadHashForOriginalPhone = hashPayload(phone, 500);

    const { service, ledger } = buildService({
      idempotencyStatus: 'COMPLETED',
      cachedResult: {
        payloadHash: payloadHashForOriginalPhone,
        response: { message: 'Withdrawal initiated successfully', transactionId: 'txn-500' },
      },
    });

    await expect(
      service.withdrawMpesa(userId, '254700000000', 500, tenantId, '127.0.0.1', 'key-1'),
    ).rejects.toThrow(BadRequestException);
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  // ── Concurrent in-flight request ───────────────────────────────────────────

  it('rejects a concurrent request while the same key is still processing', async () => {
    const { service, ledger } = buildService({ idempotencyStatus: 'PROCESSING' });

    await expect(
      service.withdrawMpesa(userId, phone, 500, tenantId, '127.0.0.1', 'key-1'),
    ).rejects.toThrow(ConflictException);
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  // ── Failure releases the key for retry ──────────────────────────────────────

  // Balance/lockedBalance/frozenSavings sufficiency is now enforced centrally by
  // LedgerService.applyBalanceChange() (see ledger.service.spec.ts), not here — this
  // test instead proves withdrawMpesa() correctly releases the idempotency key when
  // the ledger rejects the debit for any reason (e.g. insufficient available funds).
  it('releases the idempotency key when the ledger rejects the debit', async () => {
    const { service, idempotency, ledger } = buildService({ idempotencyStatus: 'NEW' });
    ledger.postEntry.mockRejectedValueOnce(
      new BadRequestException(
        'Insufficient available funds (below minimum balance, or amount is committed to a guarantor hold), or concurrent modification',
      ),
    );

    await expect(
      service.withdrawMpesa(userId, phone, 500, tenantId, '127.0.0.1', 'key-1'),
    ).rejects.toThrow(BadRequestException);
    expect(ledger.postEntry).toHaveBeenCalledTimes(1);
    expect(idempotency.release).toHaveBeenCalledTimes(1);
    expect(idempotency.complete).not.toHaveBeenCalled();
  });

  it('propagates NotFoundException and releases the key when no FOSA account exists', async () => {
    const { service, idempotency } = buildService({
      idempotencyStatus: 'NEW',
      noFosaAccount: true,
    });

    await expect(
      service.withdrawMpesa(userId, phone, 500, tenantId, '127.0.0.1', 'key-1'),
    ).rejects.toThrow(NotFoundException);
    expect(idempotency.release).toHaveBeenCalledTimes(1);
  });
});
