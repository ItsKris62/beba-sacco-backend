import { Controller, Get, HttpException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
  MemoryHealthIndicator,
  DiskHealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaClient } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';

/**
 * Health Check Controller
 *
 * @SkipThrottle() – health probes from load balancers / Render / uptime monitors
 * must not count against the global rate limit bucket.
 *
 * Both endpoints are @Public() (no JWT required).
 *
 * TODO: Phase 2 – expose OpenTelemetry metrics at /metrics
 */
@ApiTags('Health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly disk: DiskHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Custom Redis health check — uses PING command with a 2 s timeout guard */
  private async redisCheck(): Promise<HealthIndicatorResult> {
    const ok = await Promise.race([
      this.redis.ping(),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    return {
      redis: ok ? { status: 'up' } : { status: 'down', message: 'Redis PING timed out or failed' },
    };
  }

  @Public()
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Full health check (DB, memory, disk)' })
  @ApiResponse({ status: 200, description: 'All systems healthy' })
  @ApiResponse({ status: 503, description: 'One or more systems degraded' })
  check() {
    return this.health.check([
      // Database connectivity — cast to PrismaClient so terminus typing is satisfied
      () => this.prismaHealth.pingCheck('database', this.prisma as unknown as PrismaClient),

      // Redis connectivity
      () => this.redisCheck(),

      // Heap: alert above 150 MB
      () => this.memory.checkHeap('memory_heap', 150 * 1024 * 1024),

      // RSS: alert above 300 MB
      () => this.memory.checkRSS('memory_rss', 300 * 1024 * 1024),

      // Disk: warn if less than 50 % free
      () => this.disk.checkStorage('storage', { path: '/', thresholdPercent: 0.5 }),
    ]);
  }

  @Public()
  @Get('ping')
  @ApiOperation({ summary: 'Lightweight liveness probe' })
  @ApiResponse({
    status: 200,
    description: 'Returns ok + uptime + timestamp',
    schema: {
      example: {
        status: 'ok',
        uptime: 123.45,
        timestamp: '2025-01-15T12:00:00.000Z',
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

  /**
   * Phase 4 – Synthetic end-to-end health probe.
   * Runs DB + Redis + tenant table checks.
   * Returns 200 only if all pass; 503 on any failure.
   * Pinged every 2 minutes by uptime monitors.
   */
  @Public()
  @Get('synthetic')
  @ApiOperation({
    summary: 'Synthetic e2e health probe (Phase 4)',
    description: 'DB + Redis + tenant table checks. Returns 200 only if all pass.',
  })
  @ApiResponse({ status: 200, description: 'All synthetic checks passed' })
  @ApiResponse({ status: 503, description: 'One or more checks failed' })
  async synthetic() {
    const results: Record<string, { status: 'pass' | 'fail'; latencyMs: number; error?: string }> =
      {};
    let allPass = true;

    // 1. DB connectivity
    const dbStart = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      results.database = { status: 'pass', latencyMs: Date.now() - dbStart };
    } catch (err) {
      results.database = { status: 'fail', latencyMs: Date.now() - dbStart, error: String(err) };
      allPass = false;
    }

    // 2. Redis round-trip
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

    // 3. Tenant table readable
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

    if (!allPass) throw new HttpException(body, 503);
    return body;
  }
}
