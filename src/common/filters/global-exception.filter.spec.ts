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
  const status = jest.fn(() => ({ json }));
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
    const statusFn = jest.fn(() => ({ json }));
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
        statusCode: 500,
        message: 'Internal server error',
        error: 'InternalServerError',
        path: '/api/test',
      }),
    );
  });

  it('returns 404 with correct shape for HttpException', () => {
    const json = jest.fn();
    const statusFn = jest.fn(() => ({ json }));
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
        statusCode: 404,
        path: '/api/loans/missing',
        requestId: 'req-abc',
      }),
    );
  });
});
