import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs';
import { TinybirdService } from '../../modules/analytics/tinybird.service';
import { AuditService } from '../../modules/audit/audit.service'; // Assuming path
import { tenantAsyncStorage } from '../services/tenant-context.service';

/**
 * Intercepts all mutating requests (POST, PUT, PATCH, DELETE) to create
 * an audit log entry and stream it to Tinybird for real-time analytics.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly tinybirdService: TinybirdService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const { method } = req;

    // Only audit mutating actions for generic HTTP events
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return next.handle();
    }

    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: (data) => {
          const responseTime = Date.now() - startTime;
          this.logEvent(context, true, data, responseTime);
        },
        error: (error) => {
          const responseTime = Date.now() - startTime;
          this.logEvent(context, false, error, responseTime);
        },
      }),
    );
  }

  private async logEvent(
    context: ExecutionContext,
    isSuccess: boolean,
    result: any,
    responseTime: number,
  ) {
    try {
      const req = context.switchToHttp().getRequest();
      const res = context.switchToHttp().getResponse();
      const { method, path, user, params } = req;

      const store = tenantAsyncStorage.getStore();
      const tenantId = store?.tenantId;

      if (!tenantId) {
        this.logger.warn(`Audit event skipped: tenantId not found for path: ${path}`);
        return;
      }

      const resource = this.getResourceFromPath(path);
      const action = this.getAction(method, resource, context);
      const resourceId = params.id || result?.id;

      const auditPayload = {
        tenantId,
        actorId: user?.id || null,
        actorRole: user?.role || 'ANONYMOUS',
        action,
        entityType: resource,
        entityId: resourceId,
        status: isSuccess ? 'SUCCESS' : 'FAILURE',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.headers['x-request-id'],
        metadata: {
          path,
          method,
          statusCode: res.statusCode,
          responseTimeMs: responseTime,
          error: isSuccess ? undefined : { name: result.name, message: result.message },
        },
      };

      // 1. Persist to PostgreSQL via AuditService (fire-and-forget)
      this.auditService.create(auditPayload).catch((err: unknown) => {
        const message = err instanceof Error ? err.stack : String(err);
        this.logger.error('Failed to persist audit log to database', message);
      });

      // 2. Stream to Tinybird for real-time analytics (fire-and-forget)
      this.tinybirdService.trackEvent('http_api_audit_events', auditPayload);

    } catch (error) {
      const message = error instanceof Error ? error.stack : String(error);
      this.logger.error('Error in AuditInterceptor during event logging', message);
    }
  }

  private getResourceFromPath(path: string): string {
    const parts = path.split('/').filter(p => p && !['api', 'v1', 'v2', 'admin', 'members'].includes(p));
    return (parts[0] || 'system').toUpperCase();
  }

  private getAction(method: string, resource: string, context: ExecutionContext): string {
    const customAction = this.reflector.get<string>('audit_action', context.getHandler());
    if (customAction) return customAction;

    switch (method) {
      case 'POST': return `${resource}.CREATE`;
      case 'PUT': return `${resource}.UPDATE`;
      case 'PATCH': return `${resource}.UPDATE`;
      case 'DELETE': return `${resource}.DELETE`;
      default: return `${resource}.${method}`;
    }
  }
}
