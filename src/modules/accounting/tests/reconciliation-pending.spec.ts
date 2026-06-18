import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MpesaTxType, TransactionStatus, UserRole } from '@prisma/client';
import { AccountingController } from '../accounting.controller';
import { AccountingService } from '../accounting.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { ReconciliationService } from '../../financial/reconciliation.service';
import { AuditService } from '../../audit/audit.service';

const TENANT_ID = 'tenant-uuid-1';

describe('AccountingService.getPendingReconciliation()', () => {
  const prisma = {
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    mpesaTransaction: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };
  const recon = { getLatestReport: jest.fn() };
  const audit = { create: jest.fn().mockResolvedValue(undefined) };

  let service: AccountingService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountingService,
        { provide: PrismaService, useValue: prisma },
        { provide: ReconciliationService, useValue: recon },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(AccountingService);
  });

  it('returns paginated RECON_PENDING rows with tenant, date, and type filters', async () => {
    prisma.mpesaTransaction.findMany.mockResolvedValueOnce([
      {
        id: 'mpesa-uuid-1',
        reference: 'STK-ws_CO_123',
        type: MpesaTxType.STK_PUSH,
        status: TransactionStatus.RECON_PENDING,
        amount: { toString: () => '1000.0000' },
        checkoutRequestId: 'ws_CO_123',
        conversationId: null,
        mpesaReceiptNumber: 'RAB123',
        resultDesc: 'Stale PENDING after 180 minutes',
        createdAt: new Date('2026-05-08T06:30:00.000Z'),
        transaction: { reference: 'TXN-001', amount: { toString: () => '900.0000' } },
      },
    ]);
    prisma.mpesaTransaction.count.mockResolvedValueOnce(1);

    const result = await service.getPendingReconciliation(TENANT_ID, {
      page: 2,
      limit: 10,
      startDate: '2026-05-01',
      endDate: '2026-05-08',
      type: 'STK',
    });

    expect(prisma.mpesaTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          status: TransactionStatus.RECON_PENDING,
          type: MpesaTxType.STK_PUSH,
          createdAt: expect.objectContaining({
            gte: new Date('2026-05-01T00:00:00.000Z'),
            lte: new Date('2026-05-08T23:59:59.999Z'),
          }),
        }),
        skip: 10,
        take: 10,
      }),
    );
    expect(result).toEqual({
      data: [
        expect.objectContaining({
          id: 'mpesa-uuid-1',
          mpesaReference: 'RAB123',
          type: MpesaTxType.STK_PUSH,
          amount: 1000,
          flagReason: 'Stale PENDING after 180 minutes',
          mpesaReceipt: 'RAB123',
          reconciliationStatus: TransactionStatus.RECON_PENDING,
        }),
      ],
      meta: expect.objectContaining({ page: 2, limit: 10, total: 1, totalPages: 1, type: 'STK' }),
    });
  });

  it('caps limit at 100 and keeps tenant scoping mandatory', async () => {
    prisma.mpesaTransaction.findMany.mockResolvedValueOnce([]);
    prisma.mpesaTransaction.count.mockResolvedValueOnce(0);

    await service.getPendingReconciliation(TENANT_ID, { page: 1, limit: 500 });

    expect(prisma.mpesaTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID }),
        take: 100,
      }),
    );
  });
});

describe('AccountingController.getPendingReconciliation()', () => {
  const accounting = {
    getPendingReconciliation: jest.fn().mockResolvedValue({ data: [], meta: { total: 0 } }),
  };
  let controller: AccountingController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [AccountingController],
      providers: [{ provide: AccountingService, useValue: accounting }],
    }).compile();

    controller = module.get(AccountingController);
  });

  it('allows AUDITOR review access and delegates with tenant id', async () => {
    const result = await controller.getPendingReconciliation(
      { page: 1, limit: 20 },
      { id: TENANT_ID } as any,
      { role: UserRole.AUDITOR } as any,
    );

    expect(result).toEqual({ data: [], meta: { total: 0 } });
    expect(accounting.getPendingReconciliation).toHaveBeenCalledWith(TENANT_ID, {
      page: 1,
      limit: 20,
    });
  });

  it('returns 403 for unauthorized roles before querying data', async () => {
    await expect(
      controller.getPendingReconciliation(
        { page: 1, limit: 20 },
        { id: TENANT_ID } as any,
        { role: UserRole.MEMBER } as any,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(accounting.getPendingReconciliation).not.toHaveBeenCalled();
  });
});
