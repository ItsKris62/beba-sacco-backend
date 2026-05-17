import { Injectable, CanActivate, ExecutionContext, HttpException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import Redis from 'ioredis';
import { RATE_LIMIT_ENDPOINT_KEY } from '../decorators/rate-limit.decorator';
import { Counter, register } from 'prom-client';

@Injectable()
export class TenantRoleRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(TenantRoleRateLimitGuard.name);
  private redisClient: Redis;
  private rateLimits: Record<string, Record<string, string>> = {};
  private rateLimitCounter: Counter<string>;

  constructor(private reflector: Reflector) {
    this.redisClient = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    });

    try {
      this.rateLimits = JSON.parse(process.env.RATE_LIMITS || '{}');
    } catch (e) {
      this.logger.error('Failed to parse RATE_LIMITS env var. Ensure it is valid JSON.', e);
    }

    // Register Prometheus counter for real-time alerting
    this.rateLimitCounter = (register.getSingleMetric('http_429_total') as Counter<string>) || new Counter({
      name: 'http_429_total',
      help: 'Total number of 429 Too Many Requests responses',
      labelNames: ['tenant', 'role', 'endpoint'],
    });
  }

  private parseLimit(limitStr: string): { limitCount: number; windowMs: number } | null {
    const match = limitStr.match(/^(\d+)\/(second|minute|hour)$/i);
    if (!match) return null;
    
    const limitCount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    
    let windowMs = 60000; // default to minute
    if (unit === 'second') windowMs = 1000;
    if (unit === 'hour') windowMs = 3600000;
    
    return { limitCount, windowMs };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const endpoint = this.reflector.get<string>(RATE_LIMIT_ENDPOINT_KEY, context.getHandler());
    if (!endpoint) return true; // Passthrough if no decorator is applied

    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const user = req.user;
    const tenantId = req.headers['x-tenant-id'] || user?.tenantId || 'anonymous';
    const userId = user?.id || req.ip;
    const role = (user?.role || 'anonymous').toLowerCase();

    const roleLimits = this.rateLimits[role];
    if (!roleLimits || !roleLimits[endpoint]) return true; // Passthrough if role is exempt

    const parsed = this.parseLimit(roleLimits[endpoint]);
    if (!parsed) return true;
    const { limitCount, windowMs } = parsed;

    const key = `rate_limit:${tenantId}:${userId}:${endpoint}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    const pipeline = this.redisClient.pipeline();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zcard(key);

    const results = await pipeline.exec();
    const currentCount = results?.[1]?.[1] as number;

    if (currentCount >= limitCount) {
      this.rateLimitCounter.inc({ tenant: tenantId, role, endpoint });
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000).toString()); // Required by client HTTP parsers
      
      throw new HttpException({ type: 'about:blank', title: 'Too Many Requests', status: 429, detail: `Rate limit exceeded. Try again later.`, instance: req.url }, 429); // Strict RFC 7807 compliance
    } else {
      const addPipeline = this.redisClient.pipeline();
      addPipeline.zadd(key, now, `${now}-${Math.random()}`); // Ensure member uniqueness in Sorted Set
      addPipeline.pexpire(key, windowMs);
      await addPipeline.exec();
    }

    return true;
  }
}