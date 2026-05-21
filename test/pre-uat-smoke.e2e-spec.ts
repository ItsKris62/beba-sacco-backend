import { BadRequestException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { createPinoHttpOptions } from '../src/common/logging/pino.config';

describe('Pre-UAT Smoke Contracts', () => {
  it('adds correlation headers to the request and response', () => {
    const middleware = new RequestIdMiddleware();
    const req = {
      headers: { 'x-correlation-id': 'uat-correlation-1', 'x-tenant-id': 'tenant-1' },
    } as any;
    const res = { setHeader: jest.fn() } as any;
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(req.correlationId).toBe('uat-correlation-1');
    expect(req.headers['x-request-id']).toBe('uat-correlation-1');
    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-ID', 'uat-correlation-1');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', 'uat-correlation-1');
    expect(next).toHaveBeenCalled();
  });

  it('includes correlation ID in standardized error responses', () => {
    const filter = new GlobalExceptionFilter();
    const json = jest.fn();
    const response = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      json,
    };
    const request = {
      originalUrl: '/members/documents/upload-url',
      url: '/members/documents/upload-url',
      headers: { 'x-correlation-id': 'uat-error-1' },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    } as unknown as ArgumentsHost;

    filter.catch(new BadRequestException('Invalid upload request'), host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'uat-error-1',
        status: 400,
        errorCode: 'Bad Request',
      }),
    );
  });

  it('configures log redaction for upload secrets and PII', () => {
    const options = createPinoHttpOptions();
    const redact = options.redact as { paths: string[]; censor: string };

    expect(redact.censor).toBe('[REDACTED]');
    expect(redact.paths).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.body.password',
        'req.body.checksum',
        'req.body.uploadToken',
        'res.body.uploadToken',
        '*.secret',
      ]),
    );
  });
});
