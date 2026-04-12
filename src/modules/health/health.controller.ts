import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaClient } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

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
  ) {}

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

      // Heap: alert above 150 MB
      () => this.memory.checkHeap('memory_heap', 150 * 1024 * 1024),

      // RSS: alert above 300 MB
      () => this.memory.checkRSS('memory_rss', 300 * 1024 * 1024),

      // Disk: warn if less than 50 % free
      () => this.disk.checkStorage('storage', { path: '/', thresholdPercent: 0.5 }),

      // TODO: Phase 1 – Redis health indicator
      // () => this.redis.checkHealth('redis', { client: redisClient }),
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
