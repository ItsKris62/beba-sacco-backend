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

// ─── PII masking helpers ───────────────────────────────────────────────────────

/** +254712345678 → +254***5678 */
export function maskPhone(phone: string): string {
  return phone.replace(/(\+?\d{3})\d+(\d{4})$/, '$1***$2');
}

/** john.doe@example.com → jo***@example.com */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local.slice(0, Math.min(2, local.length))}***${domain}`;
}

/** Strip or mask query-string parameters that look like emails or phone numbers */
function sanitizeUrl(url: string): string {
  try {
    const qIdx = url.indexOf('?');
    if (qIdx === -1) return url;
    const base = url.slice(0, qIdx);
    const params = new URLSearchParams(url.slice(qIdx + 1));
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const PHONE_RE = /^\+?\d{9,15}$/;
    for (const [key, value] of params.entries()) {
      if (EMAIL_RE.test(value)) params.set(key, maskEmail(value));
      else if (PHONE_RE.test(value)) params.set(key, maskPhone(value));
    }
    return `${base}?${params.toString()}`;
  } catch {
    return url;
  }
}

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
    const action = this.extractAction(method, url);

    const safeUrl = sanitizeUrl(url);

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - startMs;
          this.auditService
            .create({
              tenantId,
              actorId: userId,
              action,
              entityType: resource,
              metadata: {
                url: safeUrl,
                method,
                durationMs: duration,
                status: 'success',
                payload: this.sanitizePayload(request.body),
              },
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
              actorId: userId,
              action: `${action}.ERROR`,
              entityType: resource,
              metadata: {
                url: safeUrl,
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
    if (resource === 'members' && url.includes('/loans/apply')) return 'Loan';
    if (resource === 'admin' && url.includes('/loans/')) return 'Loan';
    return resource ?? 'unknown';
  }

  private extractAction(method: string, url: string): string {
    if (method === 'POST' && url.includes('/members/loans/apply')) {
      return 'LOAN.APPLY';
    }
    if (method === 'POST' && url.includes('/guarantor-response')) {
      return 'LOAN.GUARANTOR_RESPOND';
    }
    if (method === 'PATCH' && url.includes('/admin/loans/') && url.includes('/status')) {
      return 'LOAN.STATUS_UPDATE';
    }
    return `${method}.${this.extractResource(url)}`.toUpperCase();
  }

  private sanitizePayload(payload: unknown): Record<string, unknown> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {};
    }
    const blocked = new Set(['password', 'otp', 'token', 'accessToken', 'refreshToken']);
    return Object.fromEntries(
      Object.entries(payload as Record<string, unknown>)
        .filter(([key]) => !blocked.has(key))
        .map(([key, value]) => [key, typeof value === 'string' ? value.replace(/[<>]/g, '') : value]),
    );
  }
}
