import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MetricsApiKeyGuard } from '../../src/common/guards/metrics-api-key.guard';
import { MetricsController } from '../../src/modules/metrics/metrics.controller';
import { MetricsService } from '../../src/modules/metrics/metrics.service';

describe('Metrics API Key Guard', () => {
  let app: INestApplication;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalMetricsKey = process.env.METRICS_API_KEY;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [
        MetricsApiKeyGuard,
        {
          provide: MetricsService,
          useValue: {
            getMetrics: jest.fn(
              async () => '# HELP beba_test_metric Test metric\nbeba_test_metric 1\n',
            ),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalMetricsKey === undefined) {
      delete process.env.METRICS_API_KEY;
    } else {
      process.env.METRICS_API_KEY = originalMetricsKey;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('fails closed in production when METRICS_API_KEY is unset', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.METRICS_API_KEY;

    await request(app.getHttpServer())
      .get('/api/metrics')
      .expect(401)
      .expect((res) => {
        expect(res.body.message).toBe('Invalid metrics API key');
      });
  });

  it('rejects requests without the configured bearer key', async () => {
    process.env.NODE_ENV = 'production';
    process.env.METRICS_API_KEY = 'test-metrics-key-32-characters-long';

    await request(app.getHttpServer())
      .get('/api/metrics')
      .expect(401)
      .expect((res) => {
        expect(res.body.message).toBe('Invalid metrics API key');
      });
  });

  it('returns Prometheus metrics with a valid bearer key', async () => {
    process.env.NODE_ENV = 'production';
    process.env.METRICS_API_KEY = 'test-metrics-key-32-characters-long';

    await request(app.getHttpServer())
      .get('/api/metrics')
      .set('Authorization', 'Bearer test-metrics-key-32-characters-long')
      .expect(200)
      .expect('Content-Type', /text\/plain/)
      .expect((res) => {
        expect(res.text).toContain('# HELP beba_test_metric Test metric');
      });
  });
});
