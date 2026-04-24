import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../common/services/redis.service';

// ─── Daraja API response types ────────────────────────────────────────────────

export interface DarajaTokenResponse {
  access_token: string;
  expires_in: string;
}

export interface StkPushParams {
  phoneNumber: string;       // E.164 (2547XXXXXXXXX)
  amount: number;            // Integer KES (Daraja rejects decimals)
  accountReference: string;  // Max 12 chars – account number or loan ref
  transactionDesc: string;   // Max 13 chars – visible on customer's receipt
  callbackUrl: string;       // Full HTTPS URL Safaricom will POST the result to
}

export interface StkPushResult {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage: string;
}

export interface B2cParams {
  initiatorName: string;
  securityCredential: string;     // Encrypted with Safaricom cert
  commandId: 'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment';
  amount: number;                 // Integer KES
  partyA: string;                 // B2C shortcode
  partyB: string;                 // Recipient phone (E.164)
  remarks: string;                // Max 100 chars
  occasionRef?: string;           // Optional – e.g. loan number
  resultUrl: string;
  queueTimeoutUrl: string;
}

export interface B2cResult {
  ConversationID: string;
  OriginatorConversationID: string;
  ResponseCode: string;
  ResponseDescription: string;
}

// ─────────────────────────────────────────────────────────────────────────────

const OAUTH_CACHE_KEY = 'mpesa:oauth:token';
// Cache 55 minutes – Daraja tokens live 60 min; we refresh before expiry.
const OAUTH_TTL_SEC = 3300;

@Injectable()
export class DarajaClientService {
  private readonly logger = new Logger(DarajaClientService.name);
  private readonly baseUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    const env = config.get<string>('app.mpesa.environment', 'sandbox');
    this.baseUrl =
      env === 'production'
        ? 'https://api.safaricom.co.ke'
        : 'https://sandbox.safaricom.co.ke';
  }

  // ─── OAuth Token ──────────────────────────────────────────────────────────

  /**
   * Returns a valid Daraja OAuth2 bearer token.
   * Token is cached in Redis with a 55-minute TTL so we never hammer the
   * OAuth endpoint on every request. Thread-safe: multiple concurrent calls
   * will race to set the cache, but the cost is one extra Daraja call at
   * most (not a correctness issue).
   */
  async getAccessToken(): Promise<string> {
    const cached = await this.redis.get(OAUTH_CACHE_KEY);
    if (cached) return cached;

    const key = this.config.get<string>('app.mpesa.consumerKey', '');
    const secret = this.config.get<string>('app.mpesa.consumerSecret', '');

    if (!key || !secret) {
      throw new InternalServerErrorException(
        'MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET not configured',
      );
    }

    const auth = Buffer.from(`${key}:${secret}`).toString('base64');

    const res = await this.darajaFetch<DarajaTokenResponse>(
      `${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      { method: 'GET', headers: { Authorization: `Basic ${auth}` } },
      'OAuth token',
    );

    await this.redis.set(OAUTH_CACHE_KEY, res.access_token, OAUTH_TTL_SEC);
    this.logger.log('Daraja OAuth token refreshed and cached for 55 min');
    return res.access_token;
  }

  /** Force-clear the token cache (call after 401 from Daraja) */
  async invalidateTokenCache(): Promise<void> {
    await this.redis.del(OAUTH_CACHE_KEY);
  }

  // ─── STK Push (Lipa Na M-Pesa Online) ────────────────────────────────────

  /**
   * Sends an STK Push prompt to the customer's phone.
   *
   * Password = Base64(Shortcode + Passkey + Timestamp)
   * Timestamp = YYYYMMDDHHmmss (EAT / UTC+3 per Safaricom spec)
   *
   * Always returns the raw Daraja response. The caller is responsible for
   * persisting the CheckoutRequestID before returning to the client.
   */
  async initiateSTKPush(params: StkPushParams): Promise<StkPushResult> {
    const shortcode = this.config.get<string>('app.mpesa.shortcode', '174379');
    const passkey = this.config.get<string>('app.mpesa.passkey', '');

    if (!passkey) {
      throw new InternalServerErrorException('MPESA_PASSKEY not configured');
    }
    if (!params.callbackUrl) {
      throw new InternalServerErrorException('MPESA_CALLBACK_URL not configured');
    }

    const token = await this.getAccessToken();
    const timestamp = this.buildTimestamp();
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const body = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: params.amount,
      PartyA: params.phoneNumber,
      PartyB: shortcode,
      PhoneNumber: params.phoneNumber,
      CallBackURL: params.callbackUrl,
      AccountReference: params.accountReference.slice(0, 12),
      TransactionDesc: params.transactionDesc.slice(0, 13),
    };

    return this.darajaFetch<StkPushResult>(
      `${this.baseUrl}/mpesa/stkpush/v1/processrequest`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      'STK Push',
    );
  }

  // ─── B2C (Business to Customer) ──────────────────────────────────────────

  /**
   * Sends money from the SACCO paybill to a member's phone (loan disbursement).
   *
   * The result is delivered asynchronously to params.resultUrl.
   * Daraja will NOT block waiting for the funds transfer to complete.
   *
   * Security: securityCredential must be encrypted with the Safaricom
   * Production/Sandbox public certificate before this call is made.
   */
  async initiateB2C(params: B2cParams): Promise<B2cResult> {
    const token = await this.getAccessToken();

    const body = {
      InitiatorName: params.initiatorName,
      SecurityCredential: params.securityCredential,
      CommandID: params.commandId,
      Amount: params.amount,
      PartyA: params.partyA,
      PartyB: params.partyB,
      Remarks: params.remarks.slice(0, 100),
      QueueTimeOutURL: params.queueTimeoutUrl,
      ResultURL: params.resultUrl,
      Occasion: params.occasionRef?.slice(0, 100) ?? '',
    };

    return this.darajaFetch<B2cResult>(
      `${this.baseUrl}/mpesa/b2c/v1/paymentrequest`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      'B2C',
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** YYYYMMDDHHmmss – Safaricom expects EAT (UTC+3) but accepts UTC in sandbox */
  buildTimestamp(): string {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return (
      now.getFullYear().toString() +
      p(now.getMonth() + 1) +
      p(now.getDate()) +
      p(now.getHours()) +
      p(now.getMinutes()) +
      p(now.getSeconds())
    );
  }

  /**
   * Shared fetch wrapper with unified error handling.
   * On HTTP error or non-zero ResponseCode, logs safely (no secrets in logs)
   * and throws InternalServerErrorException.
   *
   * If Daraja responds with 401, the token cache is invalidated so the next
   * call will re-authenticate.
   */
  private async darajaFetch<T>(
    url: string,
    init: RequestInit,
    label: string,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err: unknown) {
      this.logger.error(`Daraja ${label} network error`, err instanceof Error ? err.message : err);
      throw new InternalServerErrorException(`Daraja ${label} request failed (network)`);
    }

    if (res.status === 401) {
      await this.invalidateTokenCache();
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Never log the full request body (may contain credentials)
      this.logger.error(`Daraja ${label} HTTP ${res.status}`, text.slice(0, 200));
      throw new InternalServerErrorException(`Daraja ${label} HTTP error ${res.status}`);
    }

    const data = (await res.json()) as T;

    // Daraja returns HTTP 200 but ResponseCode '1' on logical errors
    const code = (data as Record<string, unknown>)['ResponseCode'];
    if (code !== undefined && code !== '0') {
      const desc = (data as Record<string, unknown>)['ResponseDescription'] ?? 'Unknown error';
      this.logger.warn(`Daraja ${label} non-zero ResponseCode ${code}: ${desc}`);
      throw new InternalServerErrorException(`Daraja ${label} rejected: ${desc}`);
    }

    return data;
  }
}
