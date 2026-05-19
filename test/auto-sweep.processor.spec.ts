import { Test, TestingModule } from '@nestjs/testing';
import { AutoSweepProcessor } from './auto-sweep.processor';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';

describe('AutoSweepProcessor', () => {
  let processor: AutoSweepProcessor;
  let redisMock: any;
  let prismaMock: any;
  let auditMock: any;

  beforeEach(async () => {
    redisMock = { setnx: jest.fn(), expire: jest.fn(), del: jest.fn() };
    auditMock = { logEvent: jest.fn() };
    prismaMock = {
      loan: { findMany: jest.fn() },
      fosaAccount: { findFirstOrThrow: jest.fn() },
      $transaction: jest.fn((cb) => cb(prismaMock)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutoSweepProcessor,
        { provide: PinoLogger, useValue: { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() } },
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditService, useValue: auditMock },
        { provide: 'REDIS_CLIENT', useValue: redisMock },
      ],
    }).compile();

    processor = module.get<AutoSweepProcessor>(AutoSweepProcessor);
  });

  it('should skip processing if Redis lock is not acquired', async () => {
    redisMock.setnx.mockResolvedValue(0); // 0 means lock taken

    const job = { data: { tenantId: 't1', mpesaReceipt: 'R123', correlationId: 'C1' } } as Job;
    await processor.process(job);

    expect(prismaMock.loan.findMany).not.toHaveBeenCalled();
  });

  it('should log AUTO.SWEEP_SKIPPED if no active/arrears loans exist', async () => {
    redisMock.setnx.mockResolvedValue(1);
    prismaMock.loan.findMany.mockResolvedValue([]);

    const job = { data: { tenantId: 't1', memberId: 'm1', mpesaReceipt: 'R123' } } as Job;
    await processor.process(job);

    expect(auditMock.logEvent).toHaveBeenCalledWith(prismaMock, expect.objectContaining({
      action: 'AUTO.SWEEP_SKIPPED',
    }));
  });

  it('should prioritize ARREARS over ACTIVE and sweep correctly', async () => {
    redisMock.setnx.mockResolvedValue(1);
    
    // Returns active loan (created earlier) and arrears loan (created later)
    prismaMock.loan.findMany.mockResolvedValue([
      { id: 'active-1', status: 'ACTIVE', totalAmountDue: '1000', createdAt: new Date('2023-01-01') },
      { id: 'arrears-1', status: 'ARREARS', totalAmountDue: '500', createdAt: new Date('2023-02-01') },
    ]);

    // Member has 700 in FOSA
    prismaMock.fosaAccount.findFirstOrThrow.mockResolvedValue({ id: 'fosa-1', balance: '700' });
    prismaMock.fosaAccount.update = jest.fn();

    const job = { data: { tenantId: 't1', memberId: 'm1', mpesaReceipt: 'R123' } } as Job;
    await processor.process(job);

    // Transaction block executes
    expect(prismaMock.$transaction).toHaveBeenCalled();

    // It should deduct 500 for the Arrears loan first
    expect(prismaMock.fosaAccount.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'fosa-1', tenantId: 't1' },
      data: { balance: { decrement: new Prisma.Decimal('500') } }
    });

    // It should deduct the remaining 200 for the Active loan
    expect(prismaMock.fosaAccount.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'fosa-1', tenantId: 't1' },
      data: { balance: { decrement: new Prisma.Decimal('200') } }
    });
  });
});