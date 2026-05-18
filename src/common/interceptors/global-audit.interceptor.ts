import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Tenant } from '@prisma/client';
import type { AuthenticatedUser } from '../../modules/auth/strategies/jwt.strategy';
import { AuditEventService } from '../../modules/audit/audit-event.service';
import { AuditMaskerService } from '../../modules/audit/audit.masker.service';

const SKIP_PATTERNS = ['/health', '/metrics', '/docs', '/favicon.ico'];

@Injectable()
export class GlobalAuditInterceptor implements NestInterceptor {
  constructor(
    private readonly auditEvents: AuditEventService,
    private readonly masker: AuditMaskerService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<
      Request & {
        user?: AuthenticatedUser;
        tenant?: Tenant;
        tenantId?: string;
      }
    >();
    const response = context.switchToHttp().getResponse<Response>();
    const startedAt = Date.now();

    if (SKIP_PATTERNS.some((pattern) => request.originalUrl.includes(pattern))) {
      return next.handle();
    }

    return next.handle().pipe(
      tap({
        next: (body: unknown) => {
          this.emit(request, response, startedAt, true, body);
        },
        error: (error: unknown) => {
          this.emit(request, response, startedAt, false, undefined, error);
        },
      }),
    );
  }

  private emit(
    request: Request & { user?: AuthenticatedUser; tenant?: Tenant; tenantId?: string },
    response: Response,
    startedAt: number,
    success: boolean,
    responseBody?: unknown,
    error?: unknown,
  ): void {
    const tenantId = request.tenant?.id ?? request.tenantId ?? (request.headers['x-tenant-id'] as string | undefined);
    if (!tenantId) {
      return;
    }

    const correlationId =
      (request.headers['x-correlation-id'] as string | undefined) ??
      (request.headers['x-request-id'] as string | undefined) ??
      '';
    const endpoint = request.originalUrl ?? request.url;
    const method = request.method.toUpperCase();
    const statusCode = response.statusCode || (success ? 200 : 500);
    const durationMs = Date.now() - startedAt;
    const resourceType = this.extractResource(endpoint);

    this.auditEvents.enqueueFireAndForget({
      tenantId,
      correlationId,
      userId: request.user?.id ?? null,
      role: request.user?.role ?? null,
      action: `HTTP_${method}`,
      resourceType,
      metadata: {
        durationMs,
        query: this.masker.maskPII(request.query),
        requestBody: this.masker.maskPII((request.body ?? {}) as Record<string, unknown>),
        responseBody: this.masker.maskPII(this.normalizeResponse(responseBody)),
      },
      ip: request.ip,
      userAgent: request.headers['user-agent'] as string | undefined,
      endpoint: this.maskQuery(endpoint),
      method,
      statusCode,
      success,
      errorCode: success ? null : this.errorCode(error),
    });
  }

  private extractResource(url: string): string {
    const parts = url.split('?')[0].split('/').filter(Boolean);
    const skip = new Set(['api', 'v1', 'v2']);
    return parts.find((part) => !skip.has(part) && !/^[0-9a-f-]{20,}$/i.test(part)) ?? 'unknown';
  }

  private normalizeResponse(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return { value };
  }

  private errorCode(error: unknown): string {
    if (error && typeof error === 'object' && 'code' in error) {
      return String((error as { code?: unknown }).code);
    }
    if (error && typeof error === 'object' && 'name' in error) {
      return String((error as { name?: unknown }).name);
    }
    return 'HTTP_ERROR';
  }

  private maskQuery(url: string): string {
    const [base, query] = url.split('?');
    if (!query) {
      return url;
    }
    const params = new URLSearchParams(query);
    for (const key of params.keys()) {
      const value = params.get(key);
      if (value) {
        params.set(key, String(this.masker.maskPII({ [key]: value })[key]));
      }
    }
    return `${base}?${params.toString()}`;
  }
}
