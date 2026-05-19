import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../app.module';
import { ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

describe('Throttler Routing Limits (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should block /auth/login after 10 requests', async () => {
    const req = () => request(app.getHttpServer())
      .post('/api/auth/login')
      .set('X-Tenant-ID', 'test-tenant')
      .send({ email: 'test@beba.com', password: 'password' });

    // Fire 10 allowed requests
    for (let i = 0; i < 10; i++) {
      const res = await req();
      // Status might be 401/400 depending on mock, but NOT 429 yet
      expect(res.status).not.toBe(429);
    }

    // 11th request must hit the Auth rate limit
    const blockedRes = await req();
    expect(blockedRes.status).toBe(429);
    
    // Ensure our global exception filter catches the ThrottlerException
    // and wraps it in our standardized envelope
    expect(blockedRes.body).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'RATE_LIMIT_EXCEEDED',
        })
      })
    );
  });
});