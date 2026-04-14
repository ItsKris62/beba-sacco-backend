import { Controller, Get } from '@nestjs/common';
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
 * TODO: Phase 1 – add Redis health indicator (requires injecting ioredis client)
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

  /** Custom Redis health check — pings with a SET/GET round-trip */
  private async redisCheck(): Promise<HealthIndicatorResult> {
    const key = 'health:ping';
    const ok = await Promise.race([
      this.redis.set(key, '1', 5).then(() => this.redis.get(key)).then((v) => v === '1'),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    return {
      redis: ok ? { status: 'up' } : { status: 'down', message: 'Redis ping failed' },
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
}
