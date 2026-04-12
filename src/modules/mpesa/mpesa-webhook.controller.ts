import { Controller, Post, Body, Logger, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { MpesaService, StkCallbackBody } from './mpesa.service';
import { Public } from '../../common/decorators/public.decorator';

/**
 * M-Pesa Webhook Controller
 *
 * All routes are @Public() — Safaricom Daraja does not send auth headers.
 * @SkipThrottle() to ensure Daraja callbacks are never rate-limited.
 *
 * Security: Daraja callbacks come from Safaricom IP ranges. In production,
 * add IP allowlist at the reverse proxy / API Gateway level rather than here.
 *
 * The handler MUST return { ResultCode: 0, ResultDesc: "Accepted" } even on
 * internal errors — otherwise Daraja will retry and spam our endpoint.
 */
@ApiTags('M-Pesa Webhooks')
@SkipThrottle()
@Controller('mpesa/webhooks')
export class MpesaWebhookController {
  private readonly logger = new Logger(MpesaWebhookController.name);

  constructor(private readonly mpesaService: MpesaService) {}

  @Public()
  @Post('stk-callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'STK Push result callback (Safaricom → server)' })
  @ApiExcludeEndpoint() // Hide from public Swagger docs
  async stkCallback(@Body() body: StkCallbackBody) {
    this.logger.debug('STK callback received', JSON.stringify(body));
    try {
      return await this.mpesaService.handleStkCallback(body);
    } catch (err: unknown) {
      // Never surface errors to Daraja — log and acknowledge
      this.logger.error(
        'Unhandled error processing STK callback',
        err instanceof Error ? err.stack : err,
      );
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }
  }
}
