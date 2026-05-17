import { Test, TestingModule } from '@nestjs/testing';
import { DeadLetterAlertProcessor } from '../src/modules/queue/dead-letter.processor';
import { AlertsService } from '../src/modules/alerts/alerts.service';
import { register } from 'prom-client';
import Redis from 'ioredis';

describe('DLQ Alerting & Processor (e2e)', () => {
  let processor: DeadLetterAlertProcessor;
  let mockAlertsService: Partial<AlertsService>;
  let redisClient: Redis;

  beforeAll(async () => {
    redisClient = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: 6379 });
    mockAlertsService = { sendSlackAlert: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeadLetterAlertProcessor,
        { provide: AlertsService, useValue: mockAlertsService },
      ],
    }).compile();

    processor = module.get<DeadLetterAlertProcessor>(DeadLetterAlertProcessor);
    await processor.onModuleInit();
    
    await redisClient.del('bull:TEST_QUEUE:meta');
    await redisClient.del('bull:TEST_QUEUE:failed');
  });

  afterAll(async () => {
    await processor.onModuleDestroy();
    await redisClient.quit();
    register.clear();
  });

  it('should detect failed jobs, expose Prometheus metric, and trigger Slack alert', async () => {
    await redisClient.set('bull:TEST_QUEUE:meta', '1');
    await redisClient.zadd('bull:TEST_QUEUE:failed', Date.now(), 'job-1');

    await processor.checkQueueDepth('TEST_QUEUE');

    expect(mockAlertsService.sendSlackAlert).toHaveBeenCalledWith(expect.stringContaining('TEST_QUEUE'));

    const metricsStr = await register.metrics();
    expect(metricsStr).toContain('bullmq_dlq_depth{queue="TEST_QUEUE"} 1');
  });

  it('should not re-alert for the same queue if not resolved', async () => {
    jest.clearAllMocks();
    await processor.checkQueueDepth('TEST_QUEUE');
    expect(mockAlertsService.sendSlackAlert).not.toHaveBeenCalled();
  });

  it('should reset alert state after queue is drained', async () => {
    await redisClient.del('bull:TEST_QUEUE:failed');
    await processor.checkQueueDepth('TEST_QUEUE'); // State resets here
    
    await redisClient.zadd('bull:TEST_QUEUE:failed', Date.now(), 'job-2');
    await processor.checkQueueDepth('TEST_QUEUE'); // Should alert again
    expect(mockAlertsService.sendSlackAlert).toHaveBeenCalledTimes(1);
  });
});