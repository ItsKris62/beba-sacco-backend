import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { nanoid } from 'nanoid';
import * as Sentry from '@sentry/nestjs';

type RequestWithCorrelation = Request & {
  correlationId?: string;
  startTime?: number;
};

/**
 * Request ID Middleware
 * 
 * Generates unique request ID for tracing
 * Can accept X-Request-ID from client or generate new one
 * 
 * Useful for:
 * - Distributed tracing
 * - Log correlation
 * - Error tracking
 * 
 * TODO: Phase 2 - Integrate with OpenTelemetry
 * TODO: Phase 3 - Add request ID propagation to downstream services
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: RequestWithCorrelation, res: Response, next: NextFunction) {
    const inboundCorrelationId = req.headers['x-correlation-id'] as string | undefined;
    const requestId = inboundCorrelationId || (req.headers['x-request-id'] as string) || nanoid();
    req.correlationId = requestId;
    req.startTime = Date.now();
    req.headers['x-request-id'] = requestId;
    req.headers['x-correlation-id'] = requestId;
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('X-Correlation-ID', requestId);
    res.setHeader('X-Correlation-Id', requestId);

    const sentryWithScope = Sentry as typeof Sentry & {
      configureScope?: (callback: (scope: { setTag: (key: string, value: string) => void }) => void) => void;
      setTag?: (key: string, value: string) => void;
    };
    sentryWithScope.configureScope?.((scope) => {
      scope.setTag('correlation_id', requestId);
      const tenantId = req.headers['x-tenant-id'];
      if (typeof tenantId === 'string') {
        scope.setTag('sacco.tenant_id', tenantId);
      }
    });
    sentryWithScope.setTag?.('correlation_id', requestId);
    const tenantId = req.headers['x-tenant-id'];
    if (typeof tenantId === 'string') {
      sentryWithScope.setTag?.('sacco.tenant_id', tenantId);
    }

    next();
  }
}
