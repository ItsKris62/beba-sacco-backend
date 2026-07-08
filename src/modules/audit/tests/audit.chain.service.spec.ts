import { AuditChainService } from '../audit.chain.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { ConfigService } from '@nestjs/config';
import type { AuditPersistJobPayload } from '../../queue/queue.constants';

describe('AuditChainService', () => {
  it('initializes a tenant chain head with updatedAt for first audit event', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      $queryRaw: jest.fn().mockResolvedValue([
        { tenantId: 'tenant-1', lastHash: 'GENESIS', sequence: BigInt(0) },
      ]),
    };
    const prisma = {
      direct: undefined,
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as PrismaService;
    const config = {
      get: jest.fn().mockReturnValue('test-audit-secret'),
    } as unknown as ConfigService;

    const service = new AuditChainService(prisma, config);
    const payload: AuditPersistJobPayload = {
      correlationId: 'corr-1',
      timestamp: '2026-07-08T12:00:00.000Z',
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'MEMBER',
      action: 'HTTP_POST',
      resourceType: 'auth',
      resourceId: null,
      oldState: null,
      newState: null,
      metadata: { path: '/auth/register' },
      ip: '127.0.0.1',
      userAgent: 'jest',
      endpoint: '/api/v1/auth/register',
      method: 'POST',
      statusCode: 201,
      success: true,
      errorCode: null,
    };

    await service.persistEvent(payload);

    const firstRawQuery = tx.$executeRaw.mock.calls[0][0] as { strings?: string[] };
    const sqlText = firstRawQuery.strings?.join(' ') ?? '';
    expect(sqlText).toContain('"updatedAt"');
    expect(sqlText).toContain('NOW()');
  });
});