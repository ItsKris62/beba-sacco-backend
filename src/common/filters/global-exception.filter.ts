import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';

interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail: string | string[];
  instance: string;
  correlationId?: string;
  timestamp: string;
  errorCode: string;
  stack?: string;
}

interface HttpExceptionBody {
  message?: string | string[];
  error?: string;
  statusCode?: number;
  [key: string]: unknown;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number;
    let detail: string | string[];
    let errorCode: string;
    let extraFields: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'string') {
        detail = body;
        errorCode = exception.name;
      } else {
        const typed = body as HttpExceptionBody;
        detail = typed.message ?? exception.message;
        errorCode = typed.error ?? exception.name;
        // Preserve any application-specific signal fields (e.g.
        // requiresPhoneVerification, phone, requires2FA, setupToken) that
        // callers pass via `throw new HttpException({ ...custom }, status)`.
        // Without this, those fields were silently dropped and the client
        // had no way to distinguish "needs 2FA" from a generic 403.
        const { message: _m, error: _e, statusCode: _s, ...rest } = typed;
        if (Object.keys(rest).length > 0) {
          extraFields = rest;
        }
      }
    } else if (
      exception instanceof Prisma.PrismaClientInitializationError ||
      (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2024')
    ) {
      // A Neon autosuspend/wake stall (or any other DB connection failure)
      // surfaces as PrismaClientInitializationError (P1001/P1002, thrown before
      // any query runs) or, if the stall exhausts pool_timeout waiting for a
      // connection, PrismaClientKnownRequestError P2024. Both mean "the app is
      // fine, the database wasn't reachable in time" — distinct from a 500
      // application bug, so the client can show connection-specific messaging.
      status = HttpStatus.SERVICE_UNAVAILABLE;
      detail = 'Database connection unavailable';
      errorCode = 'DATABASE_UNAVAILABLE';
      this.logger.error(
        `[${this.correlationId(request) ?? 'no-id'}] Database connection failure: ${exception.message}`,
        exception.stack,
      );
      Sentry.captureException(exception);
    } else if (exception instanceof Error) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      detail = 'Internal server error';
      errorCode = 'InternalServerError';
      this.logger.error(
        `[${this.correlationId(request) ?? 'no-id'}] Unhandled exception: ${exception.message}`,
        exception.stack,
      );
      Sentry.captureException(exception);
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      detail = 'An unexpected error occurred';
      errorCode = 'UnknownError';
      this.logger.error('Unknown exception type thrown', exception);
    }

    const problem: ProblemDetail = {
      type: `https://api.beba.sacco/problems/${this.toKebabCase(errorCode)}`,
      title: this.titleFor(status, errorCode),
      status,
      detail,
      instance: request.originalUrl ?? request.url,
      correlationId: this.correlationId(request),
      timestamp: new Date().toISOString(),
      errorCode,
    };

    if (process.env.NODE_ENV === 'development' && exception instanceof Error) {
      problem.stack = exception.stack;
    }

    const responseBody = extraFields ? { ...problem, ...extraFields } : problem;
    response.status(status).type('application/problem+json').json(responseBody);
  }

  private correlationId(request: Request): string | undefined {
    return (
      (request.headers['x-correlation-id'] as string | undefined) ??
      (request.headers['x-request-id'] as string | undefined)
    );
  }

  private titleFor(status: number, errorCode: string): string {
    if (status >= 500) return 'Service Error';
    if (status === HttpStatus.UNAUTHORIZED) return 'Authentication Required';
    if (status === HttpStatus.FORBIDDEN) return 'Forbidden';
    if (status === HttpStatus.NOT_FOUND) return 'Resource Not Found';
    if (status === HttpStatus.CONFLICT) return 'Conflict';
    if (status === HttpStatus.UNPROCESSABLE_ENTITY) return 'Validation Failed';
    return errorCode.replace(/Exception$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  private toKebabCase(value: string): string {
    const kebab = value
      .replace(/Exception$/, '')
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
    return kebab || 'unknown-error';
  }
}
