import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { isB2cCallback, isC2bCallback, isStkCallback } from './dto/mpesa-callback.dto';

export interface MpesaTenantResolution {
  tenantId: string;
  uniqueId: string;
  callbackType: 'STK_PUSH' | 'C2B' | 'B2C_RESULT' | 'B2C_TIMEOUT';
}

export interface MpesaCallbackValidationInput {
  rawBody?: Buffer;
  payload: Record<string, unknown>;
  signature?: string;
  timestamp?: string;
}

@Injectable()
export class MpesaTenantResolverService {
  private readonly logger = new Logger(MpesaTenantResolverService.name);
  private readonly webhookSecret?: string;
  private readonly isProduction: boolean;
  private readonly replayTtlSeconds: number;
  private readonly maxTimestampSkewSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {
    this.webhookSecret = this.config.get<string>('app.mpesa.webhookSecret');
    this.isProduction = this.config.get<string>('app.nodeEnv') === 'production';
    this.replayTtlSeconds = this.config.get<number>('app.mpesa.callbackReplayTtlSeconds', 900);
    this.maxTimestampSkewSeconds = this.config.get<number>(
      'app.mpesa.callbackMaxSkewSeconds',
      300,
    );
  }

  async validateCallback(input: MpesaCallbackValidationInput): Promise<boolean> {
    const bodyHash = createHash('sha256')
      .update(input.rawBody ?? Buffer.from(JSON.stringify(input.payload)))
      .digest('hex');

    if (!this.isSignatureValid(input.rawBody, input.signature)) {
      this.logger.warn(`M-Pesa callback rejected: invalid signature hash=${bodyHash}`);
      return false;
    }

    if (!this.isTimestampValid(input.timestamp)) {
      this.logger.warn(`M-Pesa callback rejected: stale or missing timestamp hash=${bodyHash}`);
      return false;
    }

    return this.claimReplay(bodyHash, input.signature);
  }

  async resolveTenant(payload: Record<string, unknown>): Promise<MpesaTenantResolution | null> {
    const callbackType = this.getCallbackType(payload);
    if (!callbackType) {
      return null;
    }

    const shortcode = this.extractBusinessShortCode(payload);
    const uniqueId = this.extractUniqueId(payload, callbackType);

    const tenantId =
      (shortcode ? await this.resolveByShortCode(shortcode) : null) ??
      (await this.resolveByKnownTransaction(payload)) ??
      (await this.resolveByReferencePrefix(payload));

    if (!tenantId) {
      this.logger.warn(`Unable to resolve tenant for M-Pesa callback ${uniqueId}`);
      return null;
    }

    return { tenantId, uniqueId, callbackType };
  }

  private isSignatureValid(rawBody: Buffer | undefined, signature: string | undefined): boolean {
    if (!this.webhookSecret) {
      if (this.isProduction) {
        throw new ServiceUnavailableException(
          'MPESA_WEBHOOK_SECRET is not configured; refusing live callback processing.',
        );
      }
      return true;
    }

    if (!rawBody || !signature) {
      return false;
    }

    const normalizedSignature = signature.startsWith('sha256=')
      ? signature.slice('sha256='.length)
      : signature;
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');

    try {
      const expectedBuffer = Buffer.from(expected, 'hex');
      const actualBuffer = Buffer.from(normalizedSignature, 'hex');
      return (
        expectedBuffer.length === actualBuffer.length &&
        timingSafeEqual(expectedBuffer, actualBuffer)
      );
    } catch {
      return false;
    }
  }

  private isTimestampValid(timestamp: string | undefined): boolean {
    if (!timestamp) {
      return !this.isProduction;
    }

    const parsed = /^\d+$/.test(timestamp)
      ? new Date(Number(timestamp.length === 10 ? `${timestamp}000` : timestamp))
      : new Date(timestamp);

    if (Number.isNaN(parsed.getTime())) {
      return false;
    }

    const skewSeconds = Math.abs(Date.now() - parsed.getTime()) / 1000;
    return skewSeconds <= this.maxTimestampSkewSeconds;
  }

  private async claimReplay(bodyHash: string, signature: string | undefined): Promise<boolean> {
    const replayKey = `mpesa:callback:replay:${signature ?? bodyHash}`;
    const claimed = await this.redis.set(replayKey, bodyHash, this.replayTtlSeconds, true);
    if (!claimed) {
      this.logger.warn(`M-Pesa callback replay detected hash=${bodyHash}`);
    }
    return claimed;
  }

  private getCallbackType(
    payload: Record<string, unknown>,
  ): MpesaTenantResolution['callbackType'] | null {
    if (isStkCallback(payload)) {
      return 'STK_PUSH';
    }
    if (isC2bCallback(payload)) {
      return 'C2B';
    }
    if (isB2cCallback(payload)) {
      const result = payload.Result;
      const isTimeout =
        result.ResultCode === 17 || result.ResultDesc?.toLowerCase().includes('timeout');
      return isTimeout ? 'B2C_TIMEOUT' : 'B2C_RESULT';
    }
    return null;
  }

  private extractUniqueId(
    payload: Record<string, unknown>,
    callbackType: MpesaTenantResolution['callbackType'],
  ): string {
    if (callbackType === 'STK_PUSH' && isStkCallback(payload)) {
      return payload.Body.stkCallback.CheckoutRequestID;
    }
    if (callbackType === 'C2B' && isC2bCallback(payload)) {
      return payload.TransID;
    }
    if (isB2cCallback(payload)) {
      return payload.Result.ConversationID;
    }
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private extractBusinessShortCode(payload: Record<string, unknown>): string | null {
    if (isC2bCallback(payload)) {
      return payload.BusinessShortCode;
    }
    const candidate = payload.BusinessShortCode;
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
  }

  private async resolveByShortCode(shortcode: string): Promise<string | null> {
    const cacheKey = `mpesa:shortcode:${shortcode}:tenant`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return cached;
    }

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM "Tenant"
      WHERE
        settings #>> '{mpesa,shortcode}' = ${shortcode}
        OR settings #>> '{mpesa,businessShortCode}' = ${shortcode}
        OR settings #>> '{mpesa,c2bShortcode}' = ${shortcode}
        OR settings #>> '{mpesa,stkShortcode}' = ${shortcode}
      ORDER BY "createdAt" ASC
      LIMIT 2
    `);

    if (rows.length === 1) {
      await this.redis.set(cacheKey, rows[0].id, 3600);
      return rows[0].id;
    }

    if (rows.length > 1) {
      this.logger.warn(
        `M-Pesa shortcode ${shortcode} maps to multiple tenants; falling back to references.`,
      );
    }

    return null;
  }

  private async resolveByKnownTransaction(payload: Record<string, unknown>): Promise<string | null> {
    if (isStkCallback(payload)) {
      const tx = await this.prisma.mpesaTransaction.findUnique({
        where: { checkoutRequestId: payload.Body.stkCallback.CheckoutRequestID },
        select: { tenantId: true },
      });
      return tx?.tenantId ?? null;
    }

    if (isB2cCallback(payload)) {
      const tx = await this.prisma.mpesaTransaction.findFirst({
        where: {
          OR: [
            { conversationId: payload.Result.ConversationID },
            { originatorConversationId: payload.Result.OriginatorConversationID },
          ],
        },
        select: { tenantId: true },
      });
      return tx?.tenantId ?? null;
    }

    return null;
  }

  private async resolveByReferencePrefix(payload: Record<string, unknown>): Promise<string | null> {
    const reference = this.extractReference(payload);
    if (!reference) {
      return null;
    }

    const [prefix] = reference.split(/[:|/]/);
    if (!prefix || prefix === reference) {
      return null;
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: {
        OR: [{ id: prefix }, { slug: prefix }],
      },
      select: { id: true },
    });

    return tenant?.id ?? null;
  }

  private extractReference(payload: Record<string, unknown>): string | null {
    if (isC2bCallback(payload)) {
      return payload.BillRefNumber;
    }
    if (isStkCallback(payload)) {
      return payload.Body.stkCallback.CheckoutRequestID;
    }
    if (isB2cCallback(payload)) {
      return payload.Result.ConversationID;
    }
    return null;
  }
}
