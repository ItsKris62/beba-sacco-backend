import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Standardized error response shape.
 * All API errors follow this structure for predictable client parsing.
 */
interface ErrorResponse {
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path: string;
  requestId?: string;
  /** Only present in development — never exposed in production */
  stack?: string;
}

/**
 * Shape returned by NestJS HttpException.getResponse()
 * when the exception was built from a ValidationPipe error.
 */
interface HttpExceptionBody {
  message?: string | string[];
  error?: string;
  statusCode?: number;
}

/**
 * Global Exception Filter
 *
 * Catches ALL thrown exceptions and formats them into the standardized
 * ErrorResponse shape. Never leaks stack traces in production.
 *
 * TODO: Phase 1 – send to Sentry for unhandled (5xx) errors
 * TODO: Phase 2 – add structured error codes for client-side i18n
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number;
    let message: string | string[];
    let error: string;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'string') {
        message = body;
        error = exception.name;
      } else {
        const typed = body as HttpExceptionBody;
        message = typed.message ?? exception.message;
        error = typed.error ?? exception.name;
      }
    } else if (exception instanceof Error) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
      error = 'InternalServerError';

      // Log full error for ops visibility — but never expose to client
      this.logger.error(
        `[${request.headers['x-request-id'] ?? 'no-id'}] Unhandled exception: ${exception.message}`,
        exception.stack,
      );

      // TODO: Phase 1 – Sentry.captureException(exception) here
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'An unexpected error occurred';
      error = 'UnknownError';
      this.logger.error('Unknown exception type thrown', exception);
    }

    const errorResponse: ErrorResponse = {
      statusCode: status,
      message,
      error,
      timestamp: new Date().toISOString(),
      path: request.url,
      requestId: request.headers['x-request-id'] as string | undefined,
    };

    if (process.env.NODE_ENV === 'development' && exception instanceof Error) {
      errorResponse.stack = exception.stack;
    }

    response.status(status).json(errorResponse);
  }
}
