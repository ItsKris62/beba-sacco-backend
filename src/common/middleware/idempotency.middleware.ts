import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import { createHash, randomUUID } from 'crypto';
import { RedisService } from '../services/redis.service';

const IDEMPOTENCY_KEY_HEADERS = ['idempotency-key', 'x-idempotency-key'];
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT']);
const SKIP_PATTERNS = ['/health', '/metrics', '/docs', '/favicon.ico'];

interface CachedIdempotencyResponse {
  bodyHash: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  cachedAt: string;
}

interface IdempotencyIndex {
  bodyHash: string;
  cacheKey: string;
}

@Injectable()
export class IdempotencyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(IdempotencyMiddleware.name);
  private readonly ttlSeconds: number;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {
    this.ttlSeconds = this.config.get<number>('app.idempotency.ttlSeconds', 3600);
  }

  async use(
    req: Request & { user?: { id?: string }; tenantId?: string },
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!MUTATING_METHODS.has(req.method) || SKIP_PATTERNS.some((pattern) => req.path.includes(pattern))) {
      next();
      return;
    }

    const idempotencyKey = this.getIdempotencyKey(req);
    if (!idempotencyKey) {
      next();
      return;
    }

    const correlationId = this.getCorrelationId(req, res);
    res.setHeader('X-Correlation-Id', correlationId);
    res.setHeader('X-Idempotency-Key', idempotencyKey);

    const tenantId = req.tenantId ?? (req.headers['x-tenant-id'] as string | undefined) ?? 'global';
    const userId = req.user?.id ?? this.decodeBearerSubject(req.headers.authorization) ?? 'anonymous';
    const method = req.method.toUpperCase();
    const path = this.normalizedPath(req);
    const bodyHash = this.hashBody(req.body);
    const indexKey = `idem:index:${tenantId}:${userId}:${method}:${path}:${idempotencyKey}`;
    const cacheKey = `idem:${tenantId}:${userId}:${method}:${path}:${bodyHash}:${idempotencyKey}`;

    try {
      const index = await this.redis.getJson<IdempotencyIndex>(indexKey);
      if (index && index.bodyHash !== bodyHash) {
        res.status(409).json({
          code: 'IDEMPOTENCY_KEY_MISMATCH',
          message: 'Idempotency key was reused with a different request body.',
          correlationId,
        });
        return;
      }

      const cached = await this.redis.getJson<CachedIdempotencyResponse>(index?.cacheKey ?? cacheKey);
      if (cached && cached.bodyHash === bodyHash) {
        Object.entries(cached.headers).forEach(([header, value]) => {
          if (!this.isUnsafeReplayHeader(header)) {
            res.setHeader(header, value);
          }
        });
        res.setHeader('X-Idempotency-Replayed', 'true');
        res.status(cached.status).send(cached.body);
        return;
      }
    } catch (error) {
      this.logger.warn(
        `Idempotency lookup failed; passing through. ${error instanceof Error ? error.message : String(error)}`,
      );
      next();
      return;
    }

    this.captureSuccessfulResponse(req, res, {
      idempotencyKey,
      indexKey,
      cacheKey,
      bodyHash,
      correlationId,
    });

    next();
  }

  private captureSuccessfulResponse(
    req: Request,
    res: Response,
    params: {
      idempotencyKey: string;
      indexKey: string;
      cacheKey: string;
      bodyHash: string;
      correlationId: string;
    },
  ): void {
    const originalJson = res.json.bind(res) as (body: unknown) => Response;
    const originalSend = res.send.bind(res) as (body?: unknown) => Response;
    let responseBody: unknown;
    let captured = false;

    const capture = (body: unknown): void => {
      if (!captured) {
        responseBody = body;
        captured = true;
      }
    };

    res.json = (body: unknown): Response => {
      capture(body);
      return originalJson(body);
    };

    res.send = (body?: unknown): Response => {
      capture(body);
      return originalSend(body);
    };

    res.once('finish', () => {
      if (!this.shouldCacheStatus(res.statusCode)) {
        return;
      }

      const headers = this.safeHeadersForCache(res);
      const payload: CachedIdempotencyResponse = {
        bodyHash: params.bodyHash,
        status: res.statusCode,
        headers,
        body: this.parseCapturedBody(responseBody),
        cachedAt: new Date().toISOString(),
      };

      // Fire-and-forget: a cache write failure must never affect the HTTP response.
      void Promise.all([
        this.redis.setJson(params.cacheKey, payload, this.ttlSeconds),
        this.redis.setJson(
          params.indexKey,
          { bodyHash: params.bodyHash, cacheKey: params.cacheKey } satisfies IdempotencyIndex,
          this.ttlSeconds,
        ),
      ]).catch((error: unknown) => {
        this.logger.warn(
          `Idempotency cache write failed for ${req.method} ${req.path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
  }

  private getIdempotencyKey(req: Request): string | null {
    for (const header of IDEMPOTENCY_KEY_HEADERS) {
      const value = req.headers[header];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    return null;
  }

  private getCorrelationId(req: Request, res: Response): string {
    const fromHeader =
      (req.headers['x-correlation-id'] as string | undefined) ??
      (req.headers['x-request-id'] as string | undefined);
    const correlationId = fromHeader?.trim() || randomUUID();
    req.headers['x-correlation-id'] = correlationId;
    res.setHeader('X-Request-ID', correlationId);
    return correlationId;
  }

  private normalizedPath(req: Request): string {
    return (req.baseUrl + req.path).replace(/\/+/g, '/');
  }

  private hashBody(body: unknown): string {
    return createHash('sha256').update(this.stableStringify(body ?? {}), 'utf8').digest('hex');
  }

  private stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${this.stableStringify(record[key])}`)
      .join(',')}}`;
  }

  private shouldCacheStatus(statusCode: number): boolean {
    return statusCode >= 200 && statusCode < 300;
  }

  private safeHeadersForCache(res: Response): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [header, value] of Object.entries(res.getHeaders())) {
      if (typeof value === 'string' && !this.isUnsafeReplayHeader(header)) {
        headers[header] = value;
      }
    }
    return headers;
  }

  private isUnsafeReplayHeader(header: string): boolean {
    return ['set-cookie', 'content-length', 'transfer-encoding', 'connection'].includes(
      header.toLowerCase(),
    );
  }

  private parseCapturedBody(body: unknown): unknown {
    if (Buffer.isBuffer(body)) {
      return body.toString('utf8');
    }
    if (typeof body !== 'string') {
      return body;
    }
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  private decodeBearerSubject(authorization?: string): string | null {
    if (!authorization?.startsWith('Bearer ')) {
      return null;
    }
    const [, payload] = authorization.slice('Bearer '.length).split('.');
    if (!payload) {
      return null;
    }
    try {
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const parsed = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as {
        sub?: unknown;
      };
      return typeof parsed.sub === 'string' ? parsed.sub : null;
    } catch {
      return null;
    }
  }
}
