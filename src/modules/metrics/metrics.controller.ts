import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { MetricsService } from './metrics.service';

/**
 * Prometheus /metrics endpoint.
 *
 * @Public()     — scraped by Prometheus without auth
 * @SkipThrottle — scrape interval (15s) must not burn the rate limit bucket
 * @ApiExcludeEndpoint — not shown in Swagger (internal ops endpoint)
 *
 * Returns text/plain; version=0.0.4 format expected by Prometheus.
 */
@ApiTags('Observability')
@SkipThrottle()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Prometheus metrics scrape endpoint' })
  @ApiExcludeEndpoint()
  async scrape(@Res() res: Response) {
    const body = await this.metrics.getMetrics();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.end(body);
  }
}
