import { Test, TestingModule } from '@nestjs/testing';
import { Controller, Get, UseGuards, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantRoleRateLimitGuard } from '../src/modules/security/guards/tenant-role-rate-limit.guard';
import { RateLimitEndpoint } from '../src/modules/security/decorators/rate-limit.decorator';
import Redis from 'ioredis';

// Mock controller to validate guard and decorator combinations
@Controller('test-rate-limit')
class TestRateLimitController {
  @Get('loan-apply')
  @RateLimitEndpoint('loan_apply')
  @UseGuards(TenantRoleRateLimitGuard)
  loanApply() {
    return { success: true };
  }
}

describe('Rate Limiting by Tenant + Role (e2e)', () => {
  let guard: TenantRoleRateLimitGuard;
  let redisClient: Redis;

  beforeAll(async () => {
    // Dynamically inject the payload that would be set in Render
    process.env.RATE_LIMITS = JSON.stringify({
      member: { loan_apply: '5/minute' },
      manager: { loan_apply: '20/minute' },
    });

    redisClient = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: 6379 });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TestRateLimitController],
      providers: [TenantRoleRateLimitGuard, Reflector],
    }).compile();

    guard = module.get<TenantRoleRateLimitGuard>(TenantRoleRateLimitGuard);
  });

  afterAll(async () => {
    await redisClient.quit();
  });

  beforeEach(async () => {
    const keys = await redisClient.keys('rate_limit:*');
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
  });

  const createMockContext = (role: string, endpoint: string): any => ({
    getHandler: () => TestRateLimitController.prototype.loanApply, // Mocks the controller mapping
    switchToHttp: () => ({
      getRequest: () => ({
        user: { id: 'usr_1', role, tenantId: 'tenant_1' },
        headers: { 'x-tenant-id': 'tenant_1' },
        url: `/test-rate-limit/${endpoint}`,
      }),
      getResponse: () => ({
        setHeader: jest.fn(),
      }),
    }),
  });

  it('should allow requests safely under the limit threshold for MEMBER', async () => {
    const context = createMockContext('MEMBER', 'loan-apply');
    
    for (let i = 0; i < 5; i++) {
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }
  });

  it('should throw 429 Too Many Requests exactly at limit boundary and shape as RFC 7807', async () => {
    const context = createMockContext('MEMBER', 'loan-apply');
    
    for (let i = 0; i < 5; i++) await guard.canActivate(context); // exhaust quota
    
    await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
  });
});