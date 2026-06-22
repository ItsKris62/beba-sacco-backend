import {
  Controller,
  Post,
  Body,
  Headers,
  Req,
  Logger,
  HttpCode,
  HttpStatus,
  UseGuards,
  ServiceUnavailableException,
  OnModuleInit,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../common/decorators/public.decorator';
import { MpesaIpGuard } from './guards/mpesa-ip.guard';
import { MpesaService } from './mpesa.service';
import {
  isB2cCallback,
  StkCallbackPayload,
} from './dto/mpesa-callback.dto';

/**
 * Legacy / split webhook routes retained for backward compatibility and for
 * Daraja app configurations that use separate URLs per API type.
 *
 * New integrations should configure Daraja to use the unified endpoint:
 *   POST /api/mpesa/callback  (handled by MpesaController)
 *
 * Security model (same as MpesaController.unifiedCallback):
 *  - @Public()      — no JWT required
 *  - @Throttle()    — callback routes are capped to absorb abusive spikes
 *  - MpesaIpGuard  — Safaricom IP allowlist (production only)
 *  - HMAC signature validation via X-Mpesa-Signature header
 *
 * Daraja retry behaviour: if we return any non-200 or take > 5 seconds,
 * Daraja will retry. We ALWAYS return { ResultCode: 0, ResultDesc: "Accepted" }
 * and process asynchronously via the callback queue.
 */
@ApiTags('M-Pesa Webhooks')
@Throttle({ global: { limit: 10, ttl: 60_000 } })
@Controller('mpesa/webhooks')
export class MpesaWebhookController implements OnModuleInit {
  private readonly logger = new Logger(MpesaWebhookController.name);
  private readonly webhookSecret: string | undefined;
  private readonly isProduction: boolean;

  constructor(
    private readonly mpesaService: MpesaService,
    private readonly config: ConfigService,
  ) {
    this.webhookSecret = this.config.get<string>('app.mpesa.webhookSecret');
    this.isProduction = this.config.get<string>('app.nodeEnv') === 'production';
  }

  onModuleInit(): void {
    if (!this.webhookSecret) {
      if (this.isProduction) {
        this.logger.warn(
          '⚠️  MPESA_WEBHOOK_SECRET is not set in production. ' +
          'All incoming Daraja callbacks on legacy routes will be rejected.',
        );
      } else {
        this.logger.warn(
          'MPESA_WEBHOOK_SECRET not configured — HMAC signature validation is DISABLED. ' +
          'Safe for sandbox/staging only.',
        );
      }
    }
  }

  // ─── STK Push callback ──────────────────────────────────────────────────

  @Public()
  @Post('stk-callback')
  @UseGuards(MpesaIpGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'STK Push result callback (Safaricom → server)' })
  @ApiExcludeEndpoint()
  async stkCallback(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: StkCallbackPayload,
    @Headers('x-mpesa-signature') signature?: string,
  ) {
    if (!this.isSignatureValid(req.rawBody, signature)) {
      this.logger.warn('STK callback: invalid HMAC signature – discarding');
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }

    const checkoutId = body?.Body?.stkCallback?.CheckoutRequestID ?? 'unknown';
    this.logger.debug(`STK callback received | checkout=${checkoutId}`);

    await this.safeEnqueue(body as unknown as Record<string, unknown>, 'STK_PUSH', checkoutId);
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  // ─── B2C result URL ─────────────────────────────────────────────────────

  @Public()
  @Post('b2c-result')
  @UseGuards(MpesaIpGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'B2C payment result callback (Safaricom → server)' })
  @ApiExcludeEndpoint()
  async b2cResult(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: Record<string, unknown>,
    @Headers('x-mpesa-signature') signature?: string,
  ) {
    if (!this.isSignatureValid(req.rawBody, signature)) {
      this.logger.warn('B2C result: invalid HMAC signature – discarding');
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }

    if (isB2cCallback(body)) {
      const convId = body.Result.ConversationID;
      this.logger.debug(`B2C result received | conversation=${convId}`);
      await this.safeEnqueue(body as Record<string, unknown>, 'B2C_RESULT', convId);
    } else {
      this.logger.warn('B2C result endpoint received unexpected payload structure');
    }

    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  // ─── B2C queue timeout URL ──────────────────────────────────────────────

  @Public()
  @Post('b2c-timeout')
  @UseGuards(MpesaIpGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'B2C queue timeout notification (Safaricom → server)' })
  @ApiExcludeEndpoint()
  async b2cTimeout(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: Record<string, unknown>,
    @Headers('x-mpesa-signature') signature?: string,
  ) {
    if (!this.isSignatureValid(req.rawBody, signature)) {
      this.logger.warn('B2C timeout: invalid HMAC signature – discarding');
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }

    if (isB2cCallback(body)) {
      const convId = body.Result.ConversationID;
      this.logger.warn(`B2C TIMEOUT | conversation=${convId} – queuing for retry`);
      await this.safeEnqueue(body as Record<string, unknown>, 'B2C_TIMEOUT', convId);
    }

    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * Validates HMAC-SHA256 signature using the raw request bytes.
   * We use the raw body (not the re-serialised JSON) to avoid signature
   * mismatches from different key ordering across JSON libraries.
   * Constant-time comparison prevents timing-oracle attacks.
   *
   * Behavior when MPESA_WEBHOOK_SECRET is absent:
   *  - Non-production: permissive (sandbox callbacks have no secret).
   *  - Production: throws ServiceUnavailableException so Daraja retries and
   *    operators receive an immediate alert — no unvalidated callbacks proceed.
   */
  private isSignatureValid(rawBody: Buffer | undefined, signature: string | undefined): boolean {
    if (!this.webhookSecret) {
      if (this.isProduction) {
        throw new ServiceUnavailableException(
          'MPESA_WEBHOOK_SECRET is not configured. ' +
          'Set the environment variable and redeploy before processing live callbacks.',
        );
      }
      return true;
    }

    if (!signature || !rawBody) return false;

    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    let sigBuf: Buffer;
    try {
      sigBuf = Buffer.from(signature, 'hex');
    } catch {
      return false;
    }
    if (expectedBuf.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, sigBuf);
  }

  /** Enqueue without throwing – queue failure must never stop us ACKing Daraja */
  private async safeEnqueue(
    payload: Record<string, unknown>,
    type: Parameters<MpesaService['enqueueCallback']>[1],
    uniqueId: string,
  ): Promise<void> {
    try {
      await this.mpesaService.enqueueCallback(payload, type, uniqueId);
    } catch (err: unknown) {
      this.logger.error(
        `Failed to enqueue ${type} callback (queue down?)`,
        err instanceof Error ? err.message : err,
      );
      // Do NOT rethrow – Daraja must always receive 200
    }
  }
}
