import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Observable, tap } from 'rxjs';

type RequestLike = {
  method?: string;
  url?: string;
  route?: { path?: string };
  headers?: Record<string, unknown>;
  user?: { id?: string; role?: string };
  body?: unknown;
  query?: unknown;
};

@Injectable()
export class SentryInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestLike>();
    const route = `${request.method ?? 'UNKNOWN'} ${request.route?.path ?? request.url ?? 'unknown'}`;
    const tenantId = this.headerValue(request.headers, 'x-tenant-id');

    Sentry.setContext('request_route', { route });
    if (tenantId) Sentry.setTag('tenant_id', tenantId);
    Sentry.setTag('module', this.extractModule(context));
    Sentry.setTag('operation', context.getHandler().name);
    Sentry.setUser({
      id: request.user?.id,
      role: request.user?.role,
      tenantId,
    });

    return next.handle().pipe(
      tap({
        error: (error: { status?: number }) => {
          if (error.status && error.status >= 400 && error.status < 500) return;

          Sentry.captureException(error, {
            extra: {
              requestBody: this.sanitizeBody(request.body),
              queryParams: request.query,
              headers: this.sanitizeHeaders(request.headers ?? {}),
            },
            tags: {
              module: this.extractModule(context),
              operation: context.getHandler().name,
              tenant_id: tenantId,
            },
          });
        },
      }),
    );
  }

  private sanitizeHeaders(headers: Record<string, unknown>): Record<string, unknown> {
    const sanitized = { ...headers };
    delete sanitized.authorization;
    delete sanitized.Authorization;
    delete sanitized['x-api-key'];
    delete sanitized['X-API-Key'];
    delete sanitized.cookie;
    delete sanitized.Cookie;
    return sanitized;
  }

  private sanitizeBody(body: unknown): unknown {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;

    const scrubbed = { ...(body as Record<string, unknown>) };
    for (const key of [
      'password',
      'currentPassword',
      'newPassword',
      'confirmPassword',
      'refreshToken',
      'token',
      'accessTokenJti',
    ]) {
      if (Object.prototype.hasOwnProperty.call(scrubbed, key)) {
        scrubbed[key] = '[Filtered]';
      }
    }
    return scrubbed;
  }

  private headerValue(
    headers: Record<string, unknown> | undefined,
    key: string,
  ): string | undefined {
    const value = headers?.[key] ?? headers?.[key.toLowerCase()] ?? headers?.[key.toUpperCase()];
    return typeof value === 'string' ? value : undefined;
  }

  private extractModule(context: ExecutionContext): string {
    return context.getClass().name.replace('Controller', '').toLowerCase();
  }
}
