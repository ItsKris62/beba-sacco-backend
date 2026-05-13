import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import {
  MpesaException,
  MpesaConfigException,
  MpesaNetworkException,
  MpesaServiceUnavailableException,
} from '../exceptions/mpesa.exceptions';

@Catch(MpesaException)
export class MpesaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(MpesaExceptionFilter.name);

  catch(exception: MpesaException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status: number;
    let userMessage: string;

    if (exception instanceof MpesaConfigException) {
      // Operator misconfiguration — alert loudly but shield internals from client
      this.logger.error(`M-Pesa config error: ${exception.message}`);
      status = HttpStatus.SERVICE_UNAVAILABLE;
      userMessage = 'Payment service is not properly configured. Please contact support.';
    } else if (
      exception instanceof MpesaServiceUnavailableException ||
      exception instanceof MpesaNetworkException
    ) {
      // Transient Safaricom outage — give client a retry-friendly 503
      this.logger.warn(`M-Pesa service unavailable: ${exception.message}`);
      status = HttpStatus.SERVICE_UNAVAILABLE;
      userMessage = 'M-Pesa is temporarily unavailable. Please try again in a few minutes.';
    } else {
      // OAuth failure or API-level rejection
      this.logger.error(`M-Pesa [${exception.code}]: ${exception.message}`);
      status = HttpStatus.BAD_GATEWAY;
      userMessage = 'Payment processing failed. Please try again or contact support.';
    }

    response.status(status).json({
      statusCode: status,
      error: exception.code,
      message: userMessage,
      retryable: exception.retryable,
    });
  }
}
