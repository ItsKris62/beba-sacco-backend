import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';

type RequestWithContext = IncomingMessage & {
  correlationId?: string;
  user?: { id?: string };
};

export function createPinoHttpOptions() {
  return {
    level:
      process.env.NODE_ENV === 'test'
        ? 'silent'
        : process.env.LOG_LEVEL ?? (process.env.NODE_ENV !== 'production' ? 'debug' : 'warn'),
    transport:
      process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, singleLine: false } }
        : undefined,
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const inbound =
        (req.headers['x-correlation-id'] as string | undefined) ??
        (req.headers['x-request-id'] as string | undefined);
      const correlationId = inbound ?? randomUUID();
      req.headers['x-correlation-id'] = correlationId;
      req.headers['x-request-id'] = correlationId;
      res.setHeader('X-Correlation-ID', correlationId);
      res.setHeader('X-Request-ID', correlationId);
      return correlationId;
    },
    customProps: (req: RequestWithContext) => ({
      requestId: (req.headers['x-request-id'] as string | undefined) ?? req.correlationId ?? '',
      correlationId: (req.headers['x-correlation-id'] as string | undefined) ?? req.correlationId ?? '',
      tenantId: (req.headers['x-tenant-id'] as string | undefined) ?? '',
      userId: req.user?.id ?? '',
    }),
    formatters: {
      level: (label: string) => ({ severity: label.toUpperCase() }),
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.body.password',
        'req.body.currentPassword',
        'req.body.newPassword',
        'req.body.confirmPassword',
        'req.body.refreshToken',
        'req.body.token',
        'req.body.accessTokenJti',
        'req.body.checksum',
        'req.body.uploadToken',
        'res.body.uploadToken',
        '*.password',
        '*.token',
        '*.secret',
        '*.checksum',
        '*.uploadToken',
      ],
      censor: '[REDACTED]',
    },
    base: {
      service: 'beba-sacco-api',
      version: process.env.npm_package_version ?? 'unknown',
    },
  };
}
