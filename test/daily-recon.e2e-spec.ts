import { Test, TestingModule } from '@nestjs/testing';
import { DailyReconProcessor } from '../src/modules/queue/processors/daily-recon.processor';
import { PrismaService } from '../src/prisma/prisma.service';
import { StorageService } from '../src/modules/storage/storage.service';
import { AlertsService } from '../src/modules/alerts/alerts.service';

describe('DailyReconProcessor (e2e)', () => {
  let processor: DailyReconProcessor;
  let mockPrisma: any;
  let mockStorage: any;
  let mockAlerts: any;

  beforeEach(async () => {
    mockPrisma = {
      mpesaTransaction: { count: jest.fn().mockResolvedValue(5) },
      loan: { count: jest.fn().mockResolvedValue(2) },
    };
    
    mockStorage = {
      getUploadUrlForKey: jest.fn().mockResolvedValue({ uploadUrl: 'http://localhost/mock-upload' }),
    };
    
    mockAlerts = {
      sendSlackAlert: jest.fn(),
      sendOpsEmail: jest.fn(),
    };

    // Mock global fetch for R2 URL upload
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DailyReconProcessor,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageService, useValue: mockStorage },
        { provide: AlertsService, useValue: mockAlerts },
      ],
    }).compile();

    processor = module.get<DailyReconProcessor>(DailyReconProcessor);
  });

  it('should execute daily-recon job safely, create CSV artifact, and dispatch alerts', async () => {
    const result = await processor.process({ name: 'daily-recon' } as any);

    expect(result.success).toBe(true);
    expect(result.fileKey).toContain('recon-reports/');
    expect(mockPrisma.mpesaTransaction.count).toHaveBeenCalledTimes(3); 
    expect(mockPrisma.loan.count).toHaveBeenCalledTimes(1); 
    expect(mockStorage.getUploadUrlForKey).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith('http://localhost/mock-upload', expect.any(Object));
    expect(mockAlerts.sendSlackAlert).toHaveBeenCalled();
    expect(mockAlerts.sendOpsEmail).toHaveBeenCalledWith(
      expect.stringContaining('Daily Recon Report'),
      expect.any(String),
      expect.stringContaining('Category,Metric,Count,Details') // verifies CSV payload passed
    );
  });
});
