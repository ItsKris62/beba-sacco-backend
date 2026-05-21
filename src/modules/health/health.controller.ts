import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HealthCheck } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { FeatureFlags, FEATURE_FLAG_NAMES } from '../../config/feature-flags';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { StorageService } from '../storage/storage.service';

type DependencyCheck = {
  status: 'ok' | 'error';
  critical: boolean;
  latencyMs?: number;
  error?: string;
  stack?: string;
  [key: string]: unknown;
};

@ApiTags('Health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
  ) {}

  @Public()
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness check with dependency verification' })
  @ApiResponse({ status: 200, description: 'All critical systems are healthy' })
  @ApiResponse({ status: 503, description: 'One or more critical systems failed' })
  async check() {
    const checks = await Promise.allSettled([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkStorage(),
      this.checkFeatureFlags(),
    ]);

    const results = {
      status: 'ok' as 'ok' | 'error',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? 'unknown',
      checks: {
        database: this.formatCheck(checks[0], true),
        redis: this.formatCheck(checks[1], true),
        storage: this.formatCheck(checks[2], true),
        featureFlags: this.formatCheck(checks[3], false),
      },
    };

    const hasCriticalFailure = Object.values(results.checks).some(
      (check) => check.status === 'error' && check.critical,
    );

    if (hasCriticalFailure) {
      throw new HttpException({ ...results, status: 'error' }, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return results;
  }

  @Public()
  @Get('ping')
  @ApiOperation({ summary: 'Lightweight liveness probe' })
  @ApiResponse({
    status: 200,
    description: 'Returns ok, uptime, and timestamp',
    schema: {
      example: {
        status: 'ok',
        uptime: 123.45,
        timestamp: '2026-05-20T12:00:00.000Z',
      },
    },
  })
  ping(): { status: string; uptime: number; timestamp: string } {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get('synthetic')
  @ApiOperation({
    summary: 'Synthetic end-to-end health probe',
    description: 'Database, Redis, and tenant table checks. Returns 503 on any failure.',
  })
  @ApiResponse({ status: 200, description: 'All synthetic checks passed' })
  @ApiResponse({ status: 503, description: 'One or more checks failed' })
  async synthetic() {
    const results: Record<string, { status: 'pass' | 'fail'; latencyMs: number; error?: string }> =
      {};
    let allPass = true;

    const dbStart = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      results.database = { status: 'pass', latencyMs: Date.now() - dbStart };
    } catch (err) {
      results.database = { status: 'fail', latencyMs: Date.now() - dbStart, error: String(err) };
      allPass = false;
    }

    const redisStart = Date.now();
    try {
      const testKey = `health:synthetic:${Date.now()}`;
      await this.redis.set(testKey, '1', 10);
      const val = await this.redis.get(testKey);
      if (val !== '1') throw new Error('Round-trip value mismatch');
      results.redis = { status: 'pass', latencyMs: Date.now() - redisStart };
    } catch (err) {
      results.redis = { status: 'fail', latencyMs: Date.now() - redisStart, error: String(err) };
      allPass = false;
    }

    const tenantStart = Date.now();
    try {
      await this.prisma.tenant.count();
      results.tenantTable = { status: 'pass', latencyMs: Date.now() - tenantStart };
    } catch (err) {
      results.tenantTable = {
        status: 'fail',
        latencyMs: Date.now() - tenantStart,
        error: String(err),
      };
      allPass = false;
    }

    const body = {
      status: allPass ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: results,
    };

    if (!allPass) throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }

  private async checkDatabase() {
    return this.measureLatency(async () => {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' as const };
    });
  }

  private async checkRedis() {
    return this.measureLatency(async () => {
      const ok = await this.redis.ping();
      if (!ok) throw new Error('Redis PING failed');
      return { status: 'ok' as const };
    });
  }

  private async checkStorage() {
    return this.measureLatency(async () => {
      await this.storage.healthCheck();
      return { status: 'ok' as const };
    });
  }

  private async checkFeatureFlags() {
    return {
      status: 'ok' as const,
      loaded: FEATURE_FLAG_NAMES.length,
      sample: {
        SECURE_UPLOAD_V2: FeatureFlags.SECURE_UPLOAD_V2,
        VIRUS_SCAN: FeatureFlags.VIRUS_SCAN,
      },
    };
  }

  private formatCheck(
    result: PromiseSettledResult<Record<string, unknown>>,
    critical: boolean,
  ): DependencyCheck {
    if (result.status === 'fulfilled') {
      return { status: 'ok', critical, ...result.value };
    }

    const reason =
      result.reason instanceof Error ? result.reason : new Error(String(result.reason));
    return {
      status: 'error',
      critical,
      error: reason.message,
      stack: process.env.NODE_ENV === 'development' ? reason.stack : undefined,
    };
  }

  private async measureLatency<T extends Record<string, unknown>>(
    fn: () => Promise<T>,
  ): Promise<T & { latencyMs: number }> {
    const start = Date.now();
    const result = await fn();
    return { ...result, latencyMs: Date.now() - start };
  }
}
