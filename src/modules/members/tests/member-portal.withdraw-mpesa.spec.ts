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

  function buildService(args: {
    fosaBalance?: string;
    lockedBalance?: string;
    frozenSavings?: string;
    idempotencyStatus?: 'NEW' | 'PROCESSING' | 'COMPLETED';
    cachedResult?: unknown;
    noFosaAccount?: boolean;
  } = {}) {
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
    };

    const prisma = {
      member: {
        findFirst: jest.fn().mockResolvedValue({ id: memberId, memberNumber: 'M-001' }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };

    const audit = { create: jest.fn().mockResolvedValue(undefined) };

    const ledger = {
      postEntry: jest.fn().mockImplementation(async (params: { amount: { toString(): string } }) => ({
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

    const disbursementQueue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    const service = new MemberPortalService(
      prisma as any,
      audit as any,
      {} as any, // mpesaService — unused by withdrawMpesa
      {} as any, // loansService
      {} as any, // storage
      {} as any, // accountsService
      ledger as any,
      idempotency as any,
      disbursementQueue as any,
    );

    return { service, prisma, tx, audit, ledger, idempotency, disbursementQueue };
  }

  // ── Missing key ─────────────────────────────────────────────────────────

  it('rejects a request with no idempotency key', async () => {
    const { service } = buildService();

    await expect(service.withdrawMpesa(userId, phone, 500, tenantId, '127.0.0.1', undefined)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.withdrawMpesa(userId, phone, 500, tenantId, '127.0.0.1', '   ')).rejects.toThrow(
      BadRequestException,
    );
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it('debits the FOSA account exactly once for a fresh idempotency key', async () => {
    const { service, ledger, idempotency, disbursementQueue } = buildService({ idempotencyStatus: 'NEW' });

    const result = await service.withdrawMpesa(userId, phone, 500, tenantId, '127.0.0.1', 'key-1');

    expect(ledger.postEntry).toHaveBeenCalledTimes(1);
    expect(ledger.postEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        accountId,
        direction: 'DEBIT',
        reference: `MPESA_WD-${tenantId}-${memberId}-key-1`,
      }),
    );
    expect(disbursementQueue.add).toHaveBeenCalledTimes(1);
    expect(idempotency.complete).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ message: 'Withdrawal initiated successfully', transactionId: 'txn-500' });
  });

  // ── Exact replay: same key, same payload ──────────────────────────────────

  it('returns the cached response without re-debiting on an exact replay', async () => {
    const cachedResponse = { message: 'Withdrawal initiated successfully', transactionId: 'txn-500' };
    const payloadHash = hashPayload(phone, 500);

    const { service, ledger, prisma, disbursementQueue } = buildService({
      idempotencyStatus: 'COMPLETED',
      cachedResult: { payloadHash, response: cachedResponse },
    });

    const result = await service.withdrawMpesa(userId, phone, 500, tenantId, '127.0.0.1', 'key-1');

    expect(result).toEqual(cachedResponse);
    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(disbursementQueue.add).not.toHaveBeenCalled();
    // Replay short-circuits before even resolving the member profile or FOSA account.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ── Same key, different payload ────────────────────────────────────────────

  it('rejects a replay that reuses the key with a different amount', async () => {
    const payloadHashForOriginalAmount = hashPayload(phone, 500);

    const { service, ledger, disbursementQueue } = buildService({
      idempotencyStatus: 'COMPLETED',
      cachedResult: {
        payloadHash: payloadHashForOriginalAmount,
        response: { message: 'Withdrawal initiated successfully', transactionId: 'txn-500' },
      },
    });

    // Same key, but amount changed from 500 -> 5000.
    await expect(service.withdrawMpesa(userId, phone, 5000, tenantId, '127.0.0.1', 'key-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(disbursementQueue.add).not.toHaveBeenCalled();
  });

  it('rejects a replay that reuses the key with a different phone number', async () => {
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

    await expect(service.withdrawMpesa(userId, phone, 500, tenantId, '127.0.0.1', 'key-1')).rejects.toThrow(
      ConflictException,
    );
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  // ── Failure releases the key for retry ──────────────────────────────────────

  it('releases the idempotency key when the withdrawal fails validation', async () => {
    const { service, idempotency, ledger } = buildService({
      idempotencyStatus: 'NEW',
      fosaBalance: '100', // less than the requested 500
    });

    await expect(service.withdrawMpesa(userId, phone, 500, tenantId, '127.0.0.1', 'key-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(idempotency.release).toHaveBeenCalledTimes(1);
    expect(idempotency.complete).not.toHaveBeenCalled();
  });

  it('propagates NotFoundException and releases the key when no FOSA account exists', async () => {
    const { service, idempotency } = buildService({ idempotencyStatus: 'NEW', noFosaAccount: true });

    await expect(service.withdrawMpesa(userId, phone, 500, tenantId, '127.0.0.1', 'key-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(idempotency.release).toHaveBeenCalledTimes(1);
  });
});
