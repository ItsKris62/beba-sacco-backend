import { Test, TestingModule } from '@nestjs/testing';
import { DailyJobsProcessor } from './daily-jobs.processor';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { Job } from 'bullmq';

describe('DailyJobsProcessor', () => {
  let processor: DailyJobsProcessor;
  let redisMock: any;
  let prismaMock: any;
  let metricsMock: any;

  beforeEach(async () => {
    redisMock = { setnx: jest.fn(), expire: jest.fn(), del: jest.fn() };
    metricsMock = {
      jobSpilloverTotal: { inc: jest.fn() },
      accrualSkippedTotal: { inc: jest.fn() },
      jobDurationSeconds: { startTimer: jest.fn().mockReturnValue(jest.fn()) },
    };
    prismaMock = { tenant: { findMany: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DailyJobsProcessor,
        { provide: PinoLogger, useValue: { setContext: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } },
        { provide: PrismaService, useValue: prismaMock },
        { provide: MetricsService, useValue: metricsMock },
        { provide: 'REDIS_CLIENT', useValue: redisMock },
      ],
    }).compile();

    processor = module.get<DailyJobsProcessor>(DailyJobsProcessor);
  });

  it('should terminate gracefully and log metric if run during spillover time (e.g. 05:00 EAT)', async () => {
    // Mock EAT time out of bounds (05:00 EAT is 02:00 UTC)
    jest.useFakeTimers().setSystemTime(new Date('2023-01-01T02:00:00Z'));

    const job = { name: 'DAILY_ACCRUAL', data: { correlationId: '123' } } as Job;
    await processor.process(job);

    expect(metricsMock.jobSpilloverTotal.inc).toHaveBeenCalledWith({ job: 'DAILY_ACCRUAL' });
    expect(prismaMock.tenant.findMany).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('should chunk tenants and apply Redis locks for accrual within valid window', async () => {
    // Valid time (01:00 EAT is 22:00 UTC previous day)
    jest.useFakeTimers().setSystemTime(new Date('2023-01-01T22:00:00Z'));

    prismaMock.tenant.findMany
      .mockResolvedValueOnce([{ id: 'tenant-1' }]) // First chunk
      .mockResolvedValueOnce([]); // Second chunk empty, stops loop

    redisMock.setnx.mockResolvedValue(1); // lock acquired

    const job = { name: 'DAILY_ACCRUAL', data: { correlationId: '123' } } as Job;
    await processor.process(job);

    expect(prismaMock.tenant.findMany).toHaveBeenCalledTimes(2);
    expect(redisMock.setnx).toHaveBeenCalledWith(expect.stringContaining('accrual:tenant-1:'), '1');
    expect(redisMock.expire).toHaveBeenCalled();
    jest.useRealTimers();
  });
});
