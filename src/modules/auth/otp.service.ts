import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { RedisService } from '../../common/services/redis.service';

const OTP_TTL_SECONDS = 30 * 60;
const MAX_ATTEMPTS = 3;
const OTP_KEY_PREFIX = 'otp:pwd-reset:';

interface OtpRecord {
  code: string;
  attempts: number;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Generate a 6-digit OTP and store it in Redis with a 30-minute TTL.
   * The phone number is SHA-256 hashed before being used as the Redis key.
   */
  async generate(phone: string): Promise<string> {
    const normalizedPhone = this.normalizePhoneForKey(phone);
    const code = String(randomInt(100_000, 1_000_000));
    const key = this.buildKey(normalizedPhone);

    const record: OtpRecord = { code, attempts: 0 };
    await this.redis.setJson(key, record, OTP_TTL_SECONDS);

    this.logger.log(`OTP generated for ${this.maskPhone(normalizedPhone)}`);
    return code;
  }

  /**
   * Validate an OTP for the given phone number.
   * Allows up to 3 failed attempts before invalidating the OTP.
   * Deletes the Redis key on success or after max attempts.
   */
  async validate(phone: string, code: string): Promise<boolean> {
    const normalizedPhone = this.normalizePhoneForKey(phone);
    const key = this.buildKey(normalizedPhone);
    const record = await this.redis.getJson<OtpRecord>(key);

    if (!record) return false;

    const submitted = Buffer.from(code.trim());
    const expected = Buffer.from(record.code);
    const isValid =
      submitted.length === expected.length && timingSafeEqual(submitted, expected);

    if (isValid) {
      await this.redis.del(key);
      this.logger.log(`OTP validated for ${this.maskPhone(normalizedPhone)}`);
      return true;
    }

    const nextAttempts = record.attempts + 1;
    if (nextAttempts >= MAX_ATTEMPTS) {
      await this.redis.del(key);
      this.logger.warn(
        `OTP max attempts exceeded for ${this.maskPhone(normalizedPhone)} — key deleted`,
      );
      return false;
    }

    await this.redis.setJson(key, { ...record, attempts: nextAttempts }, OTP_TTL_SECONDS);
    return false;
  }

  /** Remove a stored OTP (e.g. after successful password reset). */
  async delete(phone: string): Promise<void> {
    const key = this.buildKey(this.normalizePhoneForKey(phone));
    await this.redis.del(key);
  }

  private normalizePhoneForKey(phone: string): string {
    return phone.trim();
  }

  private buildKey(normalizedPhone: string): string {
    const hash = createHash('sha256').update(normalizedPhone).digest('hex');
    return `${OTP_KEY_PREFIX}${hash}`;
  }

  private maskPhone(phone: string): string {
    if (phone.length < 4) return '254***????';
    return `254***${phone.slice(-4)}`;
  }
}
