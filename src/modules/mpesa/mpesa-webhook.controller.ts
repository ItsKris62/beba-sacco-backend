import { Controller, Post, Body, Headers, Req, Logger, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import { MpesaService, StkCallbackBody } from './mpesa.service';
import { Public } from '../../common/decorators/public.decorator';
import { QUEUE_NAMES, MpesaCallbackJobPayload } from '../queue/queue.constants';

/**
 * M-Pesa Webhook Controller
 *
 * All routes are @Public() — Safaricom Daraja does not send auth headers.
 * @SkipThrottle() ensures Daraja callbacks are never rate-limited.
 *
 * Strategy: Enqueue callback for async processing via BullMQ.
 * Respond immediately to Daraja to prevent retries.
 * The MpesaCallbackProcessor handles the actual DB writes.
 *
 * Security: Daraja callbacks come from Safaricom IP ranges. In production,
 * add IP allowlist at the reverse proxy / API Gateway level.
 *
 * The handler MUST always return { ResultCode: 0, ResultDesc: "Accepted" }
 * to prevent Daraja from retrying indefinitely.
 */
@ApiTags('M-Pesa Webhooks')
@SkipThrottle()
@Controller('mpesa/webhooks')
export class MpesaWebhookController {
  private readonly logger = new Logger(MpesaWebhookController.name);

  private readonly webhookSecret: string | undefined;

  constructor(
    private readonly mpesaService: MpesaService,
    private readonly configService: ConfigService,
    @InjectQueue(QUEUE_NAMES.MPESA_CALLBACK)
    private readonly mpesaCallbackQueue: Queue<MpesaCallbackJobPayload>,
  ) {
    this.webhookSecret = this.configService.get<string>('app.mpesa.webhookSecret');
  }

  /**
   * Validate HMAC-SHA256 signature from Safaricom.
   * Header: X-Mpesa-Signature: <hex>
   * Signature = HMAC-SHA256(rawBody, MPESA_WEBHOOK_SECRET)
   *
   * Uses the original raw request bytes (not re-serialised JSON) to avoid
   * serialisation-order mismatches. Falls back to permissive if no secret
   * is configured (dev / sandbox mode).
   */
  private isSignatureValid(rawBody: Buffer | undefined, signature: string | undefined): boolean {
    if (!this.webhookSecret) return true; // No secret → allow all (dev mode)
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

    // timingSafeEqual requires equal-length buffers
    if (expectedBuf.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, sigBuf);
  }

  @Public()
  @Post('stk-callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'STK Push result callback (Safaricom → server)' })
  @ApiExcludeEndpoint()
  async stkCallback(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: StkCallbackBody,
    @Headers('x-mpesa-signature') signature?: string,
  ) {
    this.logger.debug('STK callback received', JSON.stringify(body));

    // HMAC signature validation using raw request bytes
    if (!this.isSignatureValid(req.rawBody, signature)) {
      this.logger.warn('STK callback rejected: invalid HMAC signature — discarding without retry');
      // Return 200 so Daraja does not retry; the payload is simply discarded
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }

    try {
      // Extract tenantId from the stored meta on the pending MpesaTransaction
      // We enqueue with a best-effort tenantId; processor re-fetches by CheckoutRequestID
      const checkoutId = body?.Body?.stkCallback?.CheckoutRequestID ?? 'unknown';

      await this.mpesaCallbackQueue.add(
        'stk-callback',
        { tenantId: 'resolve-in-processor', callbackPayload: body as unknown as Record<string, unknown> },
        {
          jobId: `stk-${checkoutId}`, // Idempotency: duplicate callbacks produce same jobId → skipped
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        },
      );

      this.logger.log(`STK callback queued: CheckoutRequestID=${checkoutId}`);
    } catch (err: unknown) {
      // Queue failure must not prevent us from acknowledging Daraja
      this.logger.error('Failed to enqueue STK callback', err instanceof Error ? err.stack : err);
    }

    // Always ACK Daraja immediately
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }
}
