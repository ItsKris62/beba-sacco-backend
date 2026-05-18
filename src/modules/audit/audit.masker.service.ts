import { Injectable } from '@nestjs/common';

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'confirmPassword',
  'refreshToken',
  'accessToken',
  'token',
  'idNumber',
  'nationalId',
  'kraPin',
  'documentUrl',
  'documentKey',
  'kycDocument',
  'securityCredential',
]);

@Injectable()
export class AuditMaskerService {
  maskPII<T>(value: T): T {
    return this.mask(value) as T;
  }

  private mask(value: unknown): unknown {
    if (value == null) {
      return value;
    }

    if (typeof value === 'string') {
      return this.maskString(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.mask(item));
    }

    if (typeof value === 'object') {
      const input = value as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      for (const [key, nestedValue] of Object.entries(input)) {
        if (SENSITIVE_KEYS.has(key) || /national|idnumber|document|password|token/i.test(key)) {
          output[key] = '[REDACTED]';
        } else if (/phone|msisdn|mobile/i.test(key) && typeof nestedValue === 'string') {
          output[key] = this.maskPhone(nestedValue);
        } else if (/email/i.test(key) && typeof nestedValue === 'string') {
          output[key] = this.maskEmail(nestedValue);
        } else {
          output[key] = this.mask(nestedValue);
        }
      }
      return output;
    }

    return value;
  }

  private maskString(value: string): string {
    if (/^\+?\d{9,15}$/.test(value)) {
      return this.maskPhone(value);
    }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return this.maskEmail(value);
    }
    return value;
  }

  private maskPhone(phone: string): string {
    return phone.replace(/(\+?\d{3})\d+(\d{4})$/, '$1***$2');
  }

  private maskEmail(email: string): string {
    const at = email.indexOf('@');
    if (at < 0) {
      return '[REDACTED]';
    }
    const local = email.slice(0, at);
    return `${local.slice(0, Math.min(2, local.length))}***${email.slice(at)}`;
  }
}
