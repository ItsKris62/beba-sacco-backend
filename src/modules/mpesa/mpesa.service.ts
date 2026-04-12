import {
  Injectable, Logger, BadRequestException, InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import { TransactionType, TransactionStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { StkPushDto } from './dto/stk-push.dto';

// ─── Daraja API response shapes ──────────────────────────────────────────────

interface DarajaTokenResponse {
  access_token: string;
  expires_in: string;
}

interface DarajaStkPushResponse {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage: string;
}

interface StkCallbackItem {
  Name: string;
  Value?: string | number;
}

interface StkCallbackMetadata {
  Item: StkCallbackItem[];
}

interface StkCallback {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResultCode: number;
  ResultDesc: string;
  CallbackMetadata?: StkCallbackMetadata;
}

export interface StkCallbackBody {
  Body: {
    stkCallback: StkCallback;
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const MPESA_TOKEN_CACHE_KEY = 'mpesa:access_token';
const MPESA_TOKEN_TTL_SECONDS = 3000; // 50 min – Daraja tokens last 3600 s; cache shorter

@Injectable()
export class MpesaService {
  private readonly logger = new Logger(MpesaService.name);

  private readonly consumerKey: string;
  private readonly consumerSecret: string;
  private readonly passkey: string;
  private readonly shortcode: string;
  private readonly callbackUrl: string;
  private readonly baseUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    this.consumerKey = config.get<string>('app.mpesa.consumerKey', '');
    this.consumerSecret = config.get<string>('app.mpesa.consumerSecret', '');
    this.passkey = config.get<string>('app.mpesa.passkey', '');
    this.shortcode = config.get<string>('app.mpesa.shortcode', '174379');
    this.callbackUrl = config.get<string>('app.mpesa.callbackUrl', '');
    const env = config.get<string>('app.mpesa.environment', 'sandbox');
    this.baseUrl =
      env === 'production'
        ? 'https://api.safaricom.co.ke'
        : 'https://sandbox.safaricom.co.ke';
  }

  // ─── OAUTH TOKEN ──────────────────────────────────────────────

  /**
   * Obtain Daraja OAuth2 bearer token.
   * Cached in Redis for ~50 min to avoid hammering the OAuth endpoint.
   */
  private async getAccessToken(): Promise<string> {
    // Try cache first
    const cached = await this.redis.get(MPESA_TOKEN_CACHE_KEY);
    if (cached) return cached;

    const auth = Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString('base64');

    const response = await fetch(
      `${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(`Daraja OAuth failed: ${response.status} – ${body}`);
      throw new InternalServerErrorException('Failed to obtain M-Pesa access token');
    }

    const data = (await response.json()) as DarajaTokenResponse;
    const token = data.access_token;

    await this.redis.set(MPESA_TOKEN_CACHE_KEY, token, MPESA_TOKEN_TTL_SECONDS);

    return token;
  }

  // ─── STK PUSH ────────────────────────────────────────────────

  /**
   * Initiate an STK Push (Lipa Na M-Pesa Online).
   *
   * Password = Base64(Shortcode + Passkey + Timestamp)
   * Timestamp format: YYYYMMDDHHmmss
   *
   * Creates a pending MpesaTransaction record before calling Daraja,
   * so we can match the callback even if the app restarts.
   */
  async stkPush(dto: StkPushDto, tenantId: string, initiatedBy: string) {
    if (!this.callbackUrl) {
      throw new BadRequestException('M-Pesa callback URL is not configured');
    }

    const token = await this.getAccessToken();
    const timestamp = this.getTimestamp();
    const password = Buffer.from(`${this.shortcode}${this.passkey}${timestamp}`).toString('base64');
    const amount = Math.ceil(dto.amount); // Daraja requires integer KES

    const body = {
      BusinessShortCode: this.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: dto.phoneNumber,
      PartyB: this.shortcode,
      PhoneNumber: dto.phoneNumber,
      CallBackURL: `${this.callbackUrl}/mpesa/webhooks/stk-callback`,
      AccountReference: dto.accountReference,
      TransactionDesc: dto.reference,
    };

    const response = await fetch(
      `${this.baseUrl}/mpesa/stkpush/v1/processrequest`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errBody = await response.text();
      this.logger.error(`STK Push failed: ${response.status} – ${errBody}`);
      throw new InternalServerErrorException('STK Push request failed. Please try again.');
    }

    const data = (await response.json()) as DarajaStkPushResponse;

    if (data.ResponseCode !== '0') {
      this.logger.warn(`STK Push non-zero response: ${data.ResponseCode} – ${data.ResponseDescription}`);
      throw new BadRequestException(`STK Push rejected: ${data.ResponseDescription}`);
    }

    // Persist pending transaction so we can match the callback
    const mpesaTxn = await this.prisma.mpesaTransaction.create({
      data: {
        tenantId,
        checkoutRequestId: data.CheckoutRequestID,
        merchantRequestId: data.MerchantRequestID,
        phoneNumber: dto.phoneNumber,
        amount: new Decimal(dto.amount).toDecimalPlaces(4).toString(),
        status: TransactionStatus.PENDING,
        // Store context needed for the callback handler
        callbackPayload: {
          meta: {
            accountReference: dto.accountReference,
            reference: dto.reference,
            initiatedBy,
            tenantId,
          },
        },
      },
    });

    this.logger.log(`STK Push initiated: CheckoutRequestID=${data.CheckoutRequestID}`);

    return {
      checkoutRequestId: data.CheckoutRequestID,
      merchantRequestId: data.MerchantRequestID,
      customerMessage: data.CustomerMessage,
      mpesaTransactionId: mpesaTxn.id,
    };
  }

  // ─── STK CALLBACK HANDLER ────────────────────────────────────

  /**
   * Process the STK Push callback from Safaricom Daraja.
   *
   * On success (ResultCode = 0):
   *   1. Update MpesaTransaction with receipt and status COMPLETED
   *   2. Find the target account from stored meta
   *   3. Create a DEPOSIT Transaction and update account balance
   *   4. Link Transaction → MpesaTransaction
   *
   * On failure (ResultCode != 0):
   *   1. Update MpesaTransaction with status FAILED and result description
   *
   * Always returns { ResultCode: 0, ResultDesc: 'Accepted' } to Safaricom
   * (non-200 would cause Daraja to keep retrying).
   */
  async handleStkCallback(body: StkCallbackBody): Promise<{ ResultCode: number; ResultDesc: string }> {
    const callback = body?.Body?.stkCallback;

    if (!callback?.CheckoutRequestID) {
      this.logger.warn('Malformed STK callback received', body);
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callback;

    const mpesaTxn = await this.prisma.mpesaTransaction.findUnique({
      where: { checkoutRequestId: CheckoutRequestID },
    });

    if (!mpesaTxn) {
      this.logger.warn(`STK callback for unknown CheckoutRequestID: ${CheckoutRequestID}`);
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }

    // Already processed (idempotency)
    if (mpesaTxn.status !== TransactionStatus.PENDING) {
      this.logger.warn(`Duplicate STK callback for ${CheckoutRequestID} – already ${mpesaTxn.status}`);
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }

    if (ResultCode !== 0) {
      // Payment failed or cancelled
      await this.prisma.mpesaTransaction.update({
        where: { id: mpesaTxn.id },
        data: {
          status: TransactionStatus.FAILED,
          resultCode: ResultCode,
          resultDesc: ResultDesc,
          callbackPayload: body as object,
        },
      });
      this.logger.log(`STK Push failed for ${CheckoutRequestID}: ${ResultDesc}`);
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }

    // ── Payment succeeded ──────────────────────────────────────
    const meta = this.extractCallbackMeta(CallbackMetadata);
    const mpesaReceiptNumber = meta.MpesaReceiptNumber;
    const amount = new Decimal(mpesaTxn.amount.toString());

    // Retrieve stored context
    const storedPayload = mpesaTxn.callbackPayload as { meta?: { accountReference?: string; reference?: string; tenantId?: string } } | null;
    const accountReference = storedPayload?.meta?.accountReference;
    const tenantId = storedPayload?.meta?.tenantId ?? mpesaTxn.tenantId;

    // Find target account by accountNumber (stored as accountReference at initiation)
    const account = accountReference
      ? await this.prisma.account.findFirst({
          where: { accountNumber: accountReference, tenantId, isActive: true },
          select: { id: true, balance: true },
        })
      : null;

    if (!account) {
      this.logger.warn(
        `STK callback: account not found for reference "${accountReference}" in tenant ${tenantId}`,
      );
      // Still mark as completed in mpesa table — don't fail Safaricom's callback
      await this.prisma.mpesaTransaction.update({
        where: { id: mpesaTxn.id },
        data: {
          status: TransactionStatus.COMPLETED,
          resultCode: ResultCode,
          resultDesc: ResultDesc,
          mpesaReceiptNumber,
          callbackPayload: body as object,
        },
      });
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }

    const reference = `MPESA-${mpesaReceiptNumber ?? uuidv4()}`;

    await this.prisma.$transaction(async (tx) => {
      // Duplicate guard
      const dup = await tx.transaction.findUnique({ where: { reference } });
      if (dup) return; // already posted

      const balanceBefore = new Decimal(account.balance.toString());
      const balanceAfter = balanceBefore.plus(amount);

      const txn = await tx.transaction.create({
        data: {
          tenantId,
          accountId: account.id,
          type: TransactionType.DEPOSIT,
          status: TransactionStatus.COMPLETED,
          amount: amount.toDecimalPlaces(4).toString(),
          balanceBefore: balanceBefore.toDecimalPlaces(4).toString(),
          balanceAfter: balanceAfter.toDecimalPlaces(4).toString(),
          reference,
          description: `M-Pesa deposit – ${mpesaReceiptNumber ?? CheckoutRequestID}`,
          processedBy: 'MPESA_SYSTEM',
        },
      });

      await tx.account.update({
        where: { id: account.id },
        data: { balance: balanceAfter.toDecimalPlaces(4).toString() },
      });

      await tx.mpesaTransaction.update({
        where: { id: mpesaTxn.id },
        data: {
          transactionId: txn.id,
          status: TransactionStatus.COMPLETED,
          resultCode: ResultCode,
          resultDesc: ResultDesc,
          mpesaReceiptNumber,
          callbackPayload: body as object,
        },
      });
    });

    this.logger.log(
      `STK callback processed: ${CheckoutRequestID} → KES ${amount.toNumber()} credited to account ${accountReference}`,
    );

    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  // ─── HELPERS ─────────────────────────────────────────────────

  /** Returns current timestamp in Daraja format: YYYYMMDDHHmmss */
  private getTimestamp(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      now.getFullYear().toString() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds())
    );
  }

  /** Extract named items from STK callback metadata */
  private extractCallbackMeta(metadata?: StkCallbackMetadata): Record<string, string> {
    if (!metadata?.Item) return {};
    return Object.fromEntries(
      metadata.Item.filter((i) => i.Value !== undefined).map((i) => [i.Name, String(i.Value)]),
    );
  }
}
