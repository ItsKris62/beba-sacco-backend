import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { nanoid } from 'nanoid';

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
  use(req: Request, res: Response, next: NextFunction) {
    const requestId = (req.headers['x-request-id'] as string) || nanoid();
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-ID', requestId);
    next();
  }
}

