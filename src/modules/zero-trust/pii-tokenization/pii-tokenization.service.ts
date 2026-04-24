/**
 * Phase 7 – PII Tokenization & Dynamic Masking Service
 * Replaces raw PII in logs, exports, and admin views with deterministic tokens.
 * Uses HMAC-SHA256 + tenant salt. Masking policies: SHOW_LAST_4, REPLACE_WITH_***, REDACT_FULL.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export type MaskingPolicy = 'SHOW_LAST_4' | 'REPLACE_WITH_STARS' | 'REDACT_FULL';

export interface TokenizationResult {
  token: string;       // Deterministic HMAC token
  masked: string;      // Human-readable masked value
  policy: MaskingPolicy;
}

@Injectable()
export class PiiTokenizationService {
  private readonly logger = new Logger(PiiTokenizationService.name);
  private readonly tenantSalts = new Map<string, string>();

  constructor(private readonly config: ConfigService) {}

  /**
   * Tokenize a PII value deterministically using HMAC-SHA256 + tenant salt.
   * Same input always produces same token (for correlation), but is irreversible.
   */
  tokenize(value: string, tenantId: string): string {
    const salt = this.getTenantSalt(tenantId);
    return crypto
      .createHmac('sha256', salt)
      .update(value)
      .digest('hex')
      .slice(0, 16); // 16-char token prefix for readability
  }

  /**
   * Apply masking policy to a PII value.
   */
  mask(value: string, policy: MaskingPolicy): string {
    if (!value) return '***';

    switch (policy) {
      case 'SHOW_LAST_4':
        if (value.length <= 4) return '****';
        return '*'.repeat(value.length - 4) + value.slice(-4);

      case 'REPLACE_WITH_STARS':
        return '*'.repeat(Math.min(value.length, 8));

      case 'REDACT_FULL':
        return '[REDACTED]';

      default:
        return '[REDACTED]';
    }
  }

  /**
   * Tokenize and mask a PII value, returning both representations.
   */
  tokenizeAndMask(value: string, tenantId: string, policy: MaskingPolicy): TokenizationResult {
    return {
      token: this.tokenize(value, tenantId),
      masked: this.mask(value, policy),
      policy,
    };
  }

  /**
   * Mask a phone number: +254712***456
   */
  maskPhone(phone: string, tenantId: string): TokenizationResult {
    const cleaned = phone.replace(/\s/g, '');
    let masked = cleaned;
    if (cleaned.length >= 7) {
      masked = cleaned.slice(0, 4) + '***' + cleaned.slice(-3);
    }
    return {
      token: this.tokenize(phone, tenantId),
      masked,
      policy: 'SHOW_LAST_4',
    };
  }

  /**
   * Mask an email: j***@example.com
   */
  maskEmail(email: string, tenantId: string): TokenizationResult {
    const [local, domain] = email.split('@');
    const maskedLocal = local.length > 2
      ? local[0] + '*'.repeat(local.length - 2) + local[local.length - 1]
      : '***';
    return {
      token: this.tokenize(email, tenantId),
      masked: `${maskedLocal}@${domain ?? '***'}`,
      policy: 'SHOW_LAST_4',
    };
  }

  /**
   * Mask a national ID: ***1234
   */
  maskNationalId(nationalId: string, tenantId: string): TokenizationResult {
    return {
      token: this.tokenize(nationalId, tenantId),
      masked: this.mask(nationalId, 'SHOW_LAST_4'),
      policy: 'SHOW_LAST_4',
    };
  }

  /**
   * Sanitize a log object by replacing PII fields with tokens.
   */
  sanitizeLogObject(
    obj: Record<string, unknown>,
    tenantId: string,
    piiFields: string[] = ['phone', 'email', 'nationalId', 'kraPin', 'password', 'refreshToken'],
  ): Record<string, unknown> {
    const sanitized = { ...obj };
    for (const field of piiFields) {
      if (field in sanitized && sanitized[field]) {
        const value = String(sanitized[field]);
        sanitized[field] = `[TOKEN:${this.tokenize(value, tenantId)}]`;
      }
    }
    return sanitized;
  }

  /**
   * Get or derive a tenant-specific salt for HMAC operations.
   */
  private getTenantSalt(tenantId: string): string {
    if (this.tenantSalts.has(tenantId)) {
      return this.tenantSalts.get(tenantId)!;
    }
    const masterSalt = this.config.get<string>('PII_TOKENIZATION_SALT') ?? 'beba-pii-salt-2026';
    const salt = crypto.createHmac('sha256', masterSalt).update(tenantId).digest('hex');
    this.tenantSalts.set(tenantId, salt);
    return salt;
  }
}
