import { HttpException, HttpStatus, ArgumentsHost } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { GlobalExceptionFilter } from './global-exception.filter';

// ─── Sentry mock ──────────────────────────────────────────────────────────────
jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeHost(url = '/api/test', requestId?: string): ArgumentsHost {
  const json = jest.fn();
  const type = jest.fn(() => ({ json }));
  const status = jest.fn(() => ({ type }));
  const headers: Record<string, string> = {};
  if (requestId) headers['x-request-id'] = requestId;

  return {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url, headers }),
    }),
  } as unknown as ArgumentsHost;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('GlobalExceptionFilter [H-3]', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    jest.clearAllMocks();
    filter = new GlobalExceptionFilter();
  });

  // ── HttpExceptions (4xx) – Sentry should NOT be called ───────────────────

  it('does NOT send 4xx HttpExceptions to Sentry', () => {
    const host = makeHost();
    filter.catch(new HttpException('Not found', HttpStatus.NOT_FOUND), host);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('does NOT send 401 Unauthorized to Sentry', () => {
    const host = makeHost();
    filter.catch(new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED), host);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('does NOT send validation errors (422) to Sentry', () => {
    const host = makeHost();
    filter.catch(
      new HttpException({ message: ['field is required'], error: 'Bad Request', statusCode: 400 }, 400),
      host,
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // ── Unhandled Errors (5xx) – Sentry MUST be called ───────────────────────

  it('[H-3] sends unhandled Error instances to Sentry.captureException', () => {
    const host = makeHost();
    const err = new Error('Database connection lost');

    filter.catch(err, host);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
  });

  it('[H-3] sends TypeError to Sentry', () => {
    const host = makeHost();
    const err = new TypeError('Cannot read property x of undefined');

    filter.catch(err, host);

    expect(Sentry.captureException).toHaveBeenCalledWith(err);
  });

  it('[H-3] sends the exact error instance (not a copy) to Sentry', () => {
    const host = makeHost();
    const err = new RangeError('Stack overflow');

    filter.catch(err, host);

    const captured = (Sentry.captureException as jest.Mock).mock.calls[0][0];
    expect(captured).toBe(err);
  });

  // ── Unknown exceptions – no Sentry call ───────────────────────────────────

  it('does NOT call Sentry for unknown non-Error exceptions', () => {
    const host = makeHost();
    filter.catch('some string thrown as exception', host);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // ── Response shape ────────────────────────────────────────────────────────

  it('returns 500 status for unhandled Error', () => {
    const json = jest.fn();
    const typeFn = jest.fn(() => ({ json }));
    const statusFn = jest.fn(() => ({ type: typeFn }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: statusFn }),
        getRequest: () => ({ url: '/api/test', headers: {} }),
      }),
    } as unknown as ArgumentsHost;

    filter.catch(new Error('boom'), host);

    expect(statusFn).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 500,
        detail: 'Internal server error',
        errorCode: 'InternalServerError',
        instance: '/api/test',
      }),
    );
  });

  it('returns 404 with correct shape for HttpException', () => {
    const json = jest.fn();
    const typeFn = jest.fn(() => ({ json }));
    const statusFn = jest.fn(() => ({ type: typeFn }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: statusFn }),
        getRequest: () => ({ url: '/api/loans/missing', headers: { 'x-request-id': 'req-abc' } }),
      }),
    } as unknown as ArgumentsHost;

    filter.catch(new HttpException('Loan not found', HttpStatus.NOT_FOUND), host);

    expect(statusFn).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 404,
        instance: '/api/loans/missing',
        correlationId: 'req-abc',
      }),
    );
  });

  // ── headersSent guard ─────────────────────────────────────────────────────

  it('does not write to the response when headers are already sent', () => {
    const json = jest.fn();
    const typeFn = jest.fn(() => ({ json }));
    const statusFn = jest.fn(() => ({ type: typeFn }));
    const loggerSpy = jest.spyOn((filter as unknown as { logger: { error: jest.Mock } }).logger, 'error');
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: statusFn, headersSent: true }),
        getRequest: () => ({ url: '/api/test', headers: {} }),
      }),
    } as unknown as ArgumentsHost;

    expect(() => filter.catch(new Error('boom after send'), host)).not.toThrow();

    expect(statusFn).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('boom after send'));
  });
});
