import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';
import type { AuthenticatedUser } from '../../modules/auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';
import { AuditService } from '../../modules/audit/audit.service';

/** Methods that mutate state — only these are audited at the HTTP level. */
const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** URL patterns to skip entirely (health, swagger, metrics). */
const SKIP_PATTERNS = ['/health', '/metrics', '/docs', '/favicon.ico'];

/**
 * Audit Trail Interceptor
 *
 * Captures HTTP-level mutation events and writes them to AuditLog.
 * Only POST/PUT/PATCH/DELETE are audited; GET/HEAD are skipped.
 *
 * Auth events (login, logout, refresh) are audited directly by AuthService
 * with richer context — this interceptor will still capture the HTTP metadata.
 *
 * Fire-and-forget: audit failure never blocks the response.
 *
 * TODO: Phase 2 – move DB write to BullMQ 'audit' queue for non-blocking async
 * TODO: Phase 3 – PII masking on request body snapshot (remove passwords, tokens)
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(private readonly auditService: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<
      Request & { user?: AuthenticatedUser; tenant?: Tenant; tenantId?: string }
    >();

    const { method, url, ip, headers } = request;
    const userAgent = headers['user-agent'] ?? '';
    const requestId = (headers['x-request-id'] as string | undefined) ?? '';

    // Skip non-mutating or infra routes
    if (
      !AUDITED_METHODS.has(method) ||
      SKIP_PATTERNS.some((p) => url.includes(p))
    ) {
      return next.handle();
    }

    const userId = request.user?.id;
    const tenantId = request.tenant?.id ?? request.tenantId;

    // Without a tenant we can't write an audit record — skip safely
    if (!tenantId) {
      return next.handle();
    }

    const startMs = Date.now();
    const resource = this.extractResource(url);
    const action = `${method}.${resource}`.toUpperCase();

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - startMs;
          this.auditService
            .create({
              tenantId,
              userId,
              action,
              resource,
              metadata: { url, method, durationMs: duration, status: 'success' },
              ipAddress: ip,
              userAgent,
              requestId,
            })
            .catch((err: unknown) =>
              this.logger.error(
                'Audit interceptor write failed (non-fatal)',
                err instanceof Error ? err.stack : err,
              ),
            );
        },
        error: (err: unknown) => {
          const duration = Date.now() - startMs;
          this.auditService
            .create({
              tenantId,
              userId,
              action: `${action}.ERROR`,
              resource,
              metadata: {
                url,
                method,
                durationMs: duration,
                status: 'error',
                errorMessage: err instanceof Error ? err.message : String(err),
              },
              ipAddress: ip,
              userAgent,
              requestId,
            })
            .catch((auditErr: unknown) =>
              this.logger.error(
                'Audit interceptor error-write failed (non-fatal)',
                auditErr instanceof Error ? auditErr.stack : auditErr,
              ),
            );
        },
      }),
    );
  }

  /** Extract resource name from URL: /api/loans/123 → loans */
  private extractResource(url: string): string {
    const parts = url.split('/').filter(Boolean);
    // Skip 'api', 'v1', 'v2' segments
    const skip = new Set(['api', 'v1', 'v2']);
    const resource = parts.find((p) => !skip.has(p) && !/^\d+$/.test(p));
    return resource ?? 'unknown';
  }
}
