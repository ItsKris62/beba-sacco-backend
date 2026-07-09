import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs';

/**
 * Request Logging Interceptor
 * 
 * Logs all incoming requests and responses
 * Includes timing information for performance monitoring
 * 
 * TODO: Phase 2 - Integrate with structured logging (Pino/Winston)
 * TODO: Phase 3 - Add correlation ID propagation
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request & { user?: { id?: string } }>();
    const { method, url } = request;
    const now = Date.now();

    return next.handle().pipe(
      tap(() => {
        const response = context.switchToHttp().getResponse<Response>();
        const { statusCode } = response;
        const duration = Date.now() - now;

        this.logger.log({
          message: 'Request completed',
          method,
          url,
          statusCode,
          durationMs: duration,
          correlationId:
            (request.headers['x-correlation-id'] as string | undefined) ??
            (request.headers['x-request-id'] as string | undefined),
          tenantId: request.headers['x-tenant-id'],
          userId: request.user?.id,
        });
      }),
    );
  }
}
