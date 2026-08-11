import { ExceptionFilter, Catch, ArgumentsHost, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import {
  B2cProviderUnavailableException,
  MpesaException,
  MpesaConfigException,
  MpesaNetworkException,
  MpesaServiceUnavailableException,
  MwaloniConfigException,
} from '../exceptions/mpesa.exceptions';

@Catch(MpesaException)
export class MpesaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(MpesaExceptionFilter.name);

  catch(exception: MpesaException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status: number;
    let userMessage: string;

    if (exception instanceof MpesaConfigException || exception instanceof MwaloniConfigException) {
      this.logger.error(`${this.providerLabel(exception)} config error: ${exception.message}`);
      status = HttpStatus.SERVICE_UNAVAILABLE;
      userMessage = 'Payment service is not properly configured. Please contact support.';
    } else if (exception instanceof B2cProviderUnavailableException) {
      this.logger.error(`B2C provider unavailable: ${exception.message}`);
      status = HttpStatus.SERVICE_UNAVAILABLE;
      userMessage = 'B2C payment provider is unavailable. Please contact support.';
    } else if (
      exception instanceof MpesaServiceUnavailableException ||
      exception instanceof MpesaNetworkException
    ) {
      this.logger.warn(
        `${this.providerLabel(exception)} service unavailable: ${exception.message}`,
      );
      status = HttpStatus.SERVICE_UNAVAILABLE;
      userMessage = 'M-Pesa is temporarily unavailable. Please try again in a few minutes.';
    } else {
      this.logger.error(
        `${this.providerLabel(exception)} [${exception.code}]: ${exception.message}`,
      );
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

  private providerLabel(exception: MpesaException): string {
    if (exception.code.startsWith('MWALONI_') || exception.code.startsWith('B2C_PROVIDER_')) {
      return 'Mwaloni';
    }
    return 'M-Pesa';
  }
}
