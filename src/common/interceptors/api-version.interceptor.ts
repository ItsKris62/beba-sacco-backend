import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Response } from 'express';

export const DEPRECATED_API_KEY = 'deprecatedApi';

/**
 * ApiVersionInterceptor – Phase 4
 *
 * Adds versioning headers to all responses:
 *   - `API-Version: 1` (current)
 *   - `Deprecation: true` + `Sunset: <date>` if the endpoint is marked @Deprecated
 *
 * Usage on a controller or handler:
 *   @SetMetadata('deprecatedApi', { sunset: '2026-12-31', replacement: '/api/v2/loans' })
 */
@Injectable()
export class ApiVersionInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const deprecation = this.reflector.getAllAndOverride<{
      sunset: string;
      replacement?: string;
    }>(DEPRECATED_API_KEY, [context.getHandler(), context.getClass()]);

    return next.handle().pipe(
      tap(() => {
        const res = context.switchToHttp().getResponse<Response>();
        res.setHeader('API-Version', '1');

        if (deprecation) {
          res.setHeader('Deprecation', 'true');
          res.setHeader('Sunset', deprecation.sunset);
          if (deprecation.replacement) {
            res.setHeader('Link', `<${deprecation.replacement}>; rel="successor-version"`);
          }
        }
      }),
    );
  }
}
