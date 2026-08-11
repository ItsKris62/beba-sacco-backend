import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { RedisService } from '../../common/services/redis.service';
import {
  MpesaApiException,
  MpesaConfigException,
  MpesaException,
  MpesaNetworkException,
  MpesaOAuthException,
  MpesaServiceUnavailableException,
} from './exceptions/mpesa.exceptions';

export interface MwaloniResponse {
  status?: string;
  message?: string;
  data?: {
    token?: string;
    tokenType?: string;
    expiresIn?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface MwaloniMobileParams {
  orderNumber: string;
  phoneNumber: string;
  amount: number;
  description: string;
}

const DEFAULT_TOKEN_TTL_SECONDS = 55 * 60;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;

@Injectable()
export class MwaloniClientService implements OnModuleInit {
  private readonly logger = new Logger(MwaloniClientService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    if (!this.isEnabled()) return;

    const missing = this.getMissingConfig();
    if (missing.length > 0) {
      this.logger.warn(
        `Mwaloni B2C is enabled but missing config: ${missing.join(', ')}. ` +
          'FOSA withdrawals to M-Pesa will fail until these are set.',
      );
    }
  }

  isEnabled(): boolean {
    return this.config.get<boolean>('app.mwaloni.enabled', false);
  }

  async sendMobile(params: MwaloniMobileParams): Promise<MwaloniResponse> {
    this.assertConfigured();
    const body = {
      channel: 'daraja-mobile',
      service_id: this.getRequiredConfig('serviceId', 'MWALONI_SERVICE_ID'),
      order_number: params.orderNumber,
      amount: params.amount,
      account_number: params.phoneNumber,
      description: params.description,
      country_code: 'KE',
      currency_code: 'KES',
    };

    return this.makeRequest('send-money', body, 'send money');
  }

  async getStatus(orderNumber: string): Promise<MwaloniResponse> {
    this.assertConfigured();
    return this.makeRequest('get-transaction-status', { orderNumber }, 'transaction status');
  }

  async fetchBalance(): Promise<MwaloniResponse> {
    this.assertConfigured();
    return this.makeRequest(
      'get-balance',
      { service_id: this.getRequiredConfig('serviceId', 'MWALONI_SERVICE_ID') },
      'balance',
    );
  }

  private async authenticate(): Promise<string> {
    this.assertConfigured();

    const username = this.getRequiredConfig('username', 'MWALONI_USERNAME');
    const password = this.getRequiredConfig('password', 'MWALONI_PASSWORD');
    const cacheKey = this.tokenCacheKey(username);
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const response = await this.post<MwaloniResponse>(
      'authenticate',
      { username, password },
      undefined,
      'authentication',
    );

    if (response.status !== '00' || !response.data?.token) {
      throw new MpesaOAuthException(
        `Mwaloni authentication failed: ${response.message ?? 'missing token'}`,
        false,
      );
    }

    const ttl = Math.max(
      60,
      Math.min(Number(response.data.expiresIn ?? DEFAULT_TOKEN_TTL_SECONDS) - 300, DEFAULT_TOKEN_TTL_SECONDS),
    );
    await this.redis.set(cacheKey, response.data.token, ttl);
    this.logger.log('Mwaloni token refreshed and cached');
    return response.data.token;
  }

  private async makeRequest(
    endpoint: string,
    body: Record<string, unknown>,
    label: string,
  ): Promise<MwaloniResponse> {
    const token = await this.authenticate();
    return this.post<MwaloniResponse>(endpoint, body, token, label);
  }

  private async post<T>(
    endpoint: string,
    body: Record<string, unknown>,
    token: string | undefined,
    label: string,
  ): Promise<T> {
    const apiKey = this.getRequiredConfig('apiKey', 'MWALONI_API_KEY');
    const url = `${this.baseUrl()}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    return this.withRetry(
      async () => {
        let res: Response;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          throw new MpesaNetworkException(`Mwaloni ${label}: ${message}`);
        }

        if (res.status === 401) {
          await this.redis.del(this.tokenCacheKey(this.getRequiredConfig('username', 'MWALONI_USERNAME')));
          throw new MpesaOAuthException('Mwaloni returned 401 - token expired or credentials rejected', true);
        }

        if (res.status >= 500) {
          throw new MpesaServiceUnavailableException(`Mwaloni ${label} HTTP ${res.status}`);
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new MpesaApiException(String(res.status), `Mwaloni ${label} HTTP ${res.status}: ${text.slice(0, 120)}`);
        }

        return (await res.json()) as T;
      },
      RETRY_ATTEMPTS,
      RETRY_BASE_MS,
      label,
    );
  }

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
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (error instanceof MpesaException && !error.retryable) throw error;

        if (attempt < maxAttempts) {
          const delay = baseDelayMs * 2 ** (attempt - 1);
          this.logger.warn(
            `Mwaloni ${label} attempt ${attempt}/${maxAttempts} failed; retrying in ${delay}ms - ${lastError.message}`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (lastError instanceof MpesaException) throw lastError;
    throw new MpesaServiceUnavailableException(
      `Mwaloni ${label} failed after ${maxAttempts} attempts: ${lastError.message}`,
    );
  }

  private baseUrl(): string {
    const env = this.config.get<string>('app.mwaloni.env', 'sandbox');
    const configured =
      env === 'production'
        ? this.config.get<string>('app.mwaloni.urlProduction', 'https://wallet.mwaloni.com/api/')
        : this.config.get<string>('app.mwaloni.urlSandbox', 'https://wallet-stg.mwaloni.com/api/');
    return configured.endsWith('/') ? configured : `${configured}/`;
  }

  private assertConfigured(): void {
    const missing = this.getMissingConfig();
    if (missing.length > 0) {
      throw new MpesaConfigException(missing.join(' / '));
    }
  }

  private getMissingConfig(): string[] {
    return [
      ['serviceId', 'MWALONI_SERVICE_ID'],
      ['username', 'MWALONI_USERNAME'],
      ['password', 'MWALONI_PASSWORD'],
      ['apiKey', 'MWALONI_API_KEY'],
    ]
      .filter(([key]) => !this.config.get<string>(`app.mwaloni.${key}`)?.trim())
      .map(([, envName]) => envName);
  }

  private getRequiredConfig(key: string, envName: string): string {
    const value = this.config.get<string>(`app.mwaloni.${key}`)?.trim();
    if (!value) throw new MpesaConfigException(envName);
    return value;
  }

  private tokenCacheKey(username: string): string {
    const env = this.config.get<string>('app.mwaloni.env', 'sandbox');
    const apiKey = this.config.get<string>('app.mwaloni.apiKey', '');
    const hash = createHash('sha256').update(`${username}:${apiKey}`).digest('hex').slice(0, 12);
    return `mwaloni:token:${env}:${hash}`;
  }
}
