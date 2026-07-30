import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { RedisService } from '../../common/services/redis.service';
import {
  MpesaException,
  MpesaConfigException,
  MpesaNetworkException,
  MpesaOAuthException,
  MpesaServiceUnavailableException,
  MpesaApiException,
} from './exceptions/mpesa.exceptions';

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

export interface MpesaConfigValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Safaricom issues C2B (collections) and B2C (disbursements) as separate
 * Daraja apps in production, each with its own consumer key/secret — see
 * MPESA_CONSUMER_KEY/SECRET (C2B) vs MPESA_B2C_CONSUMER_KEY/SECRET (B2C).
 */
export type DarajaProduct = 'c2b' | 'b2c';

export interface OAuthConnectivityResult {
  success: boolean;
  latencyMs: number;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────

// Cache 55 minutes – Daraja tokens live 60 min; we refresh before expiry.
const OAUTH_TTL_SEC = 3300;
// OAuth retry: 3 attempts with 1 s base → waits 1 s, then 2 s (max 3 s extra).
const OAUTH_RETRY_ATTEMPTS = 3;
const OAUTH_RETRY_BASE_MS = 1000;

@Injectable()
export class DarajaClientService implements OnModuleInit {
  private readonly logger = new Logger(DarajaClientService.name);
  private readonly baseUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    const env = this.getConfigValue('app.mpesa.environment', 'sandbox');
    this.baseUrl =
      env === 'production'
        ? 'https://api.safaricom.co.ke'
        : 'https://sandbox.safaricom.co.ke';
  }

  onModuleInit(): void {
    const { valid, errors } = this.validateConfig();
    if (!valid) {
      errors.forEach(e => this.logger.warn(`M-Pesa config issue: ${e}`));
      this.logger.warn(
        `DarajaClientService started with ${errors.length} config problem(s). ` +
        'STK Push and B2C calls will fail until these are resolved.',
      );
    }
  }

  // ─── Config validation ────────────────────────────────────────────────────

  /**
   * Validates that all required M-Pesa env vars are set and correctly formatted.
   * Safe to call synchronously — does not make any network requests.
   */
  validateConfig(): MpesaConfigValidation {
    const errors: string[] = [];

    const required: [string, string][] = [
      ['app.mpesa.consumerKey', 'MPESA_CONSUMER_KEY'],
      ['app.mpesa.consumerSecret', 'MPESA_CONSUMER_SECRET'],
      ['app.mpesa.passkey', 'MPESA_PASSKEY'],
      ['app.mpesa.shortcode', 'MPESA_SHORTCODE'],
      ['app.mpesa.callbackUrl', 'MPESA_CALLBACK_URL'],
      ['app.mpesa.b2cConsumerKey', 'MPESA_B2C_CONSUMER_KEY'],
      ['app.mpesa.b2cConsumerSecret', 'MPESA_B2C_CONSUMER_SECRET'],
    ];

    for (const [key, name] of required) {
      if (!this.getConfigValue(key)) errors.push(`${name} is not set`);
    }

    const callbackUrl = this.getConfigValue('app.mpesa.callbackUrl');
    if (callbackUrl) {
      try {
        const parsed = new URL(callbackUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          errors.push('MPESA_CALLBACK_URL must use http or https protocol');
        }
      } catch {
        errors.push(`MPESA_CALLBACK_URL is not a valid URL: "${callbackUrl}"`);
      }
    }

    // Verify the derived base URL is well-formed (guards against bad MPESA_ENVIRONMENT values)
    try {
      new URL(this.baseUrl);
    } catch {
      errors.push(`Daraja base URL is invalid: "${this.baseUrl}"`);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Makes a live OAuth call (bypasses cache) to verify that the consumer
   * key/secret are accepted by Safaricom. Use only for health checks or
   * one-off diagnostics — do not call on every request.
   */
  async testOAuthConnectivity(product: DarajaProduct = 'c2b'): Promise<OAuthConnectivityResult> {
    const start = Date.now();
    try {
      await this.invalidateTokenCache(product);
      await this.getAccessToken(product);
      return { success: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ─── OAuth Token ──────────────────────────────────────────────────────────

  /**
   * Returns a valid Daraja OAuth2 bearer token for the given product.
   * C2B (collections) and B2C (disbursements) are separate Daraja apps in
   * production with their own consumer key/secret, so each gets its own
   * cached token.
   * Token is cached in Redis with a 55-minute TTL to avoid hammering the OAuth
   * endpoint on every request. The token fetch retries up to 3× with exponential
   * backoff (1 s → 2 s) to survive momentary Safaricom hiccups.
   */
  async getAccessToken(product: DarajaProduct = 'c2b'): Promise<string> {
    const { key, secret, envVarNames } = this.getCredentials(product);

    if (!key || !secret) {
      throw new MpesaConfigException(envVarNames);
    }

    const cacheKey = this.oauthCacheKey(product, key);
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const auth = Buffer.from(`${key}:${secret}`).toString('base64');
    const url = `${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`;

    const res = await this.withRetry(
      () =>
        this.darajaFetch<DarajaTokenResponse>(
          url,
          { method: 'GET', headers: { Authorization: `Basic ${auth}` } },
          'OAuth token',
          product,
        ),
      OAUTH_RETRY_ATTEMPTS,
      OAUTH_RETRY_BASE_MS,
      'OAuth token',
    );

    await this.redis.set(cacheKey, res.access_token, OAUTH_TTL_SEC);
    this.logger.log(`Daraja ${product.toUpperCase()} OAuth token refreshed and cached for 55 min`);
    return res.access_token;
  }

  /** Force-clear the token cache for a product (call after 401 from Daraja). */
  async invalidateTokenCache(product: DarajaProduct = 'c2b'): Promise<void> {
    const { key } = this.getCredentials(product);
    await this.redis.del(this.oauthCacheKey(product, key));
  }

  /** Resolves the consumer key/secret pair for the given Daraja product. */
  private getCredentials(
    product: DarajaProduct,
  ): { key: string; secret: string; envVarNames: string } {
    if (product === 'b2c') {
      return {
        key: this.getConfigValue('app.mpesa.b2cConsumerKey'),
        secret: this.getConfigValue('app.mpesa.b2cConsumerSecret'),
        envVarNames: 'MPESA_B2C_CONSUMER_KEY / MPESA_B2C_CONSUMER_SECRET',
      };
    }
    return {
      key: this.getConfigValue('app.mpesa.consumerKey'),
      secret: this.getConfigValue('app.mpesa.consumerSecret'),
      envVarNames: 'MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET',
    };
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
    const shortcode = this.getConfigValue('app.mpesa.shortcode', '174379');
    const passkey = this.getConfigValue('app.mpesa.passkey');

    if (!passkey) throw new MpesaConfigException('MPESA_PASSKEY');
    if (!params.callbackUrl) throw new MpesaConfigException('MPESA_CALLBACK_URL');

    const token = await this.getAccessToken('c2b');
    const timestamp = this.buildTimestamp();
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const body = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: String(params.amount),
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
      'c2b',
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
    const token = await this.getAccessToken('b2c');

    const body = {
      InitiatorName: params.initiatorName,
      SecurityCredential: params.securityCredential,
      CommandID: params.commandId,
      Amount: String(params.amount),
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
      'b2c',
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
   * Retries `fn` up to `maxAttempts` times using exponential back-off.
   *
   * - Non-retryable MpesaExceptions (e.g. config errors, bad credentials) propagate immediately.
   * - Retryable exceptions and unknown errors wait `baseDelayMs * 2^(attempt-1)` before retry.
   * - After all attempts are exhausted, wraps the last error in MpesaServiceUnavailableException
   *   unless it was already a typed MpesaException.
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    maxAttempts: number,
    baseDelayMs: number,
    label: string,
  ): Promise<T> {
    let lastError: Error = new Error('No attempts made');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Permanent failures — don't retry (bad creds, missing config, etc.)
        if (err instanceof MpesaException && !err.retryable) throw err;

        if (attempt < maxAttempts) {
          const delay = baseDelayMs * 2 ** (attempt - 1);
          this.logger.warn(
            `Daraja ${label} attempt ${attempt}/${maxAttempts} failed; ` +
            `retrying in ${delay}ms — ${lastError.message}`,
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (lastError instanceof MpesaException) throw lastError;
    throw new MpesaServiceUnavailableException(
      `Daraja ${label} failed after ${maxAttempts} attempts: ${lastError.message}`,
    );
  }

  /**
   * Shared fetch wrapper with typed error handling.
   *
   * Error mapping:
   *   - Network failure (fetch throws)  → MpesaNetworkException      (retryable)
   *   - HTTP 401                        → MpesaOAuthException         (retryable: token refresh)
   *   - HTTP 5xx                        → MpesaServiceUnavailableException (retryable)
   *   - HTTP 4xx (other)                → MpesaApiException            (permanent)
   *   - HTTP 200 + non-zero ResponseCode→ MpesaApiException            (permanent)
   *
   * Never logs request bodies (may contain credentials or PII).
   */
  private async darajaFetch<T>(
    url: string,
    init: RequestInit,
    label: string,
    product: DarajaProduct = 'c2b',
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Daraja ${label} network error: ${msg}`);
      throw new MpesaNetworkException(`Daraja ${label}: ${msg}`);
    }

    if (res.status === 401) {
      await this.invalidateTokenCache(product);
      throw new MpesaOAuthException(
        `Daraja ${label} returned 401 — token expired or credentials rejected`,
        true,
      );
    }

    if (res.status >= 500) {
      const text = await res.text().catch(() => '');
      this.logger.error(`Daraja ${label} HTTP ${res.status} (server error)`, text.slice(0, 200));
      throw new MpesaServiceUnavailableException(`Daraja ${label} HTTP ${res.status}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.error(`Daraja ${label} HTTP ${res.status}`, text.slice(0, 200));
      // 4xx from the OAuth endpoint means Safaricom rejected the credentials —
      // the fix is to update the matching env vars, not to retry.
      if (label === 'OAuth token') {
        const { envVarNames } = this.getCredentials(product);
        throw new MpesaOAuthException(
          `Daraja OAuth returned HTTP ${res.status} — verify ${envVarNames} match your ${product.toUpperCase()} app (${this.getConfigValue('app.mpesa.environment', 'sandbox')}) in the Safaricom Developer Portal`,
          false,
        );
      }
      throw new MpesaApiException(String(res.status), `Daraja ${label} HTTP ${res.status}`);
    }

    const data = (await res.json()) as T;

    // Daraja returns HTTP 200 but ResponseCode '1' on logical errors
    const code = (data as Record<string, unknown>)['ResponseCode'];
    if (code !== undefined && code !== '0') {
      const desc = String(
        (data as Record<string, unknown>)['ResponseDescription'] ?? 'Unknown error',
      );
      this.logger.warn(`Daraja ${label} non-zero ResponseCode ${code}: ${desc}`);
      throw new MpesaApiException(String(code), desc);
    }

    return data;
  }

  private getConfigValue(key: string, fallback = ''): string {
    return (this.config.get<string>(key, fallback) ?? fallback).trim();
  }

  private oauthCacheKey(product: DarajaProduct, consumerKey: string): string {
    const env = this.getConfigValue('app.mpesa.environment', 'sandbox');
    const keyHash = createHash('sha256').update(consumerKey).digest('hex').slice(0, 12);
    return `mpesa:oauth:token:${env}:${product}:${keyHash}`;
  }
}
