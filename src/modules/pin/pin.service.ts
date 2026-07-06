import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PinPurpose } from '@prisma/client';
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { AuditService } from '../audit/audit.service';
import { SmsService } from '../sms/sms.service';
import { SmsJobPayload } from '../queue/queue.constants';
import { maskPhone } from '../mpesa/utils/mpesa.utils';

const CODE_LENGTH = 8;
const MAX_ATTEMPTS = 5;
const KEY_PREFIX = 'pin';

// Excludes visually ambiguous characters (I/l/O/0/1) so codes read unambiguously
// over SMS. Matches the charset used by UsersService.generateTempPassword().
const CODE_UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LOWER = 'abcdefghjkmnpqrstuvwxyz';
const CODE_DIGITS = '23456789';
const CODE_SYMBOLS = '@#$!';
const CODE_ALL = CODE_UPPER + CODE_LOWER + CODE_DIGITS + CODE_SYMBOLS;

// Business requirement: PIN expires in exactly 20 minutes, for both onboarding and reset.
const PIN_TTL_SECONDS: Record<PinPurpose, number> = {
  FIRST_LOGIN: 20 * 60,
  PASSWORD_RESET: 20 * 60,
};

interface PinRedisRecord {
  codeHash: string;
  attempts: number;
}

export interface IssuedPin {
  pin: string;
  verificationId: string;
  expiresAt: Date;
}

@Injectable()
export class PinService {
  private readonly logger = new Logger(PinService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly auditService: AuditService,
    private readonly smsService: SmsService,
  ) {}

  /**
   * Generate a new PIN, persist its hash (Postgres + Redis), and dispatch it via SMS.
   * Any previously unconsumed PIN for the same user/purpose is revoked first, so at
   * most one PIN can ever be valid at a time.
   */
  async generateAndIssuePin(
    userId: string,
    tenantId: string,
    purpose: PinPurpose,
    requestedByIp?: string,
  ): Promise<IssuedPin> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { phone: true, phoneNumber: true, firstName: true },
    });
    const phone = user.phone ?? user.phoneNumber;
    if (!phone) {
      throw new Error(`Cannot issue PIN — user ${userId} has no phone number on file`);
    }

    const pin = this.generateCode(CODE_LENGTH);
    const codeHash = this.hashPin(pin);
    const ttlSeconds = PIN_TTL_SECONDS[purpose];
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    await this.invalidateActivePins(userId, purpose);

    const record = await this.prisma.pinVerification.create({
      data: {
        tenantId,
        userId,
        purpose,
        codeHash,
        length: CODE_LENGTH,
        expiresAt,
        requestedByIp,
      },
    });

    await this.redis.setJson<PinRedisRecord>(
      this.buildKey(tenantId, userId, purpose),
      { codeHash, attempts: 0 },
      ttlSeconds,
    );

    await this.dispatchSms(phone, pin, purpose, ttlSeconds, userId, user.firstName);

    this.logger.log(
      `PIN issued for user=${userId} purpose=${purpose} phone=${maskPhone(phone)} expiresAt=${expiresAt.toISOString()}`,
    );

    return { pin, verificationId: record.id, expiresAt };
  }

  /**
   * Validate a submitted PIN against the fast Redis path. On success the PIN is
   * consumed (deleted) and the user's phoneVerified flag is set. Attempts are
   * capped at MAX_ATTEMPTS, after which the PIN is invalidated outright.
   */
  async validatePin(
    userId: string,
    tenantId: string,
    purpose: PinPurpose,
    plainPin: string,
  ): Promise<boolean> {
    const key = this.buildKey(tenantId, userId, purpose);
    const record = await this.redis.getJson<PinRedisRecord>(key);

    if (!record) return false;

    const isValid = this.timingSafeCompare(this.hashPin(plainPin.trim()), record.codeHash);

    if (isValid) {
      await this.redis.del(key);
      await this.markConsumed(userId, tenantId, purpose);
      this.logger.log(`PIN validated for user=${userId} purpose=${purpose}`);
      return true;
    }

    const nextAttempts = record.attempts + 1;
    await this.recordAttempts(userId, tenantId, purpose, nextAttempts);

    if (nextAttempts >= MAX_ATTEMPTS) {
      await this.redis.del(key);
      this.logger.warn(
        `PIN max attempts exceeded for user=${userId} purpose=${purpose} — key deleted`,
      );
      return false;
    }

    await this.redis.setJson(key, { ...record, attempts: nextAttempts }, PIN_TTL_SECONDS[purpose]);
    return false;
  }

  /**
   * Admin "reveal PIN" fallback. Never returns a previously-issued PIN — always
   * revokes the old one and issues a fresh PIN (SMS'd again), so no plaintext PIN
   * is ever retained at rest. Recorded as ADMIN_REVEAL_PIN in the audit chain.
   */
  async regenerateAndRevealPin(
    userId: string,
    tenantId: string,
    adminId: string,
    purpose: PinPurpose = PinPurpose.FIRST_LOGIN,
    requestedByIp?: string,
  ): Promise<IssuedPin> {
    const issued = await this.generateAndIssuePin(userId, tenantId, purpose, requestedByIp);

    await this.auditService.create({
      tenantId,
      actorId: adminId,
      action: 'ADMIN_REVEAL_PIN',
      entityType: 'User',
      entityId: userId,
      metadata: { purpose, verificationId: issued.verificationId },
      ipAddress: requestedByIp,
    });

    return issued;
  }

  /**
   * Hourly abuse guard for PIN-issuing call sites (each issuance costs a real SMS).
   * Throws 429 once `limit` is exceeded within `windowSeconds` for the given scope key.
   * Callers pick the scope: per-admin for resend/reveal, per-IP+phone for public requests.
   */
  async assertIssuanceRateLimit(scopeKey: string, limit: number, windowSeconds: number): Promise<void> {
    const count = await this.redis.incr(`pin:ratelimit:${scopeKey}`, windowSeconds);
    if (count > limit) {
      throw new HttpException('Too many PIN requests. Please try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /**
   * Generate an 8-character code guaranteed to contain at least one uppercase
   * letter, one lowercase letter, one digit, and one symbol, then shuffle so
   * the category order isn't predictable.
   */
  private generateCode(length: number): string {
    const chars = [
      this.pickChar(CODE_UPPER),
      this.pickChar(CODE_LOWER),
      this.pickChar(CODE_DIGITS),
      this.pickChar(CODE_SYMBOLS),
    ];

    while (chars.length < length) {
      chars.push(this.pickChar(CODE_ALL));
    }

    for (let i = chars.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }

    return chars.join('');
  }

  private pickChar(chars: string): string {
    return chars[randomInt(chars.length)];
  }

  private hashPin(pin: string): string {
    return createHash('sha256').update(pin).digest('hex');
  }

  private timingSafeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }

  private buildKey(tenantId: string, userId: string, purpose: PinPurpose): string {
    return `${KEY_PREFIX}:${tenantId}:${userId}:${purpose}`;
  }

  private async dispatchSms(
    phone: string,
    pin: string,
    purpose: PinPurpose,
    ttlSeconds: number,
    userId: string,
    firstName: string,
  ): Promise<void> {
    const expiresInMinutes = Math.round(ttlSeconds / 60);
    const message =
      purpose === PinPurpose.FIRST_LOGIN
        ? `Hello ${firstName}, your Beba SACCO temporary access code is ${pin}. ` +
          `It expires in ${expiresInMinutes} minutes. Do not share this with anyone.`
        : `Your Beba SACCO password reset code is ${pin}. It expires in ${expiresInMinutes} minutes. ` +
          'Do not share this code with anyone.';

    const type: SmsJobPayload['type'] =
      purpose === PinPurpose.FIRST_LOGIN ? 'FIRST_LOGIN_PIN' : 'PASSWORD_RESET_OTP';

    await this.smsService.enqueueSms(
      { type, phone, message },
      `pin.${purpose.toLowerCase()}:${userId}`,
    );
  }

  private async invalidateActivePins(userId: string, purpose: PinPurpose): Promise<void> {
    await this.prisma.pinVerification.updateMany({
      where: { userId, purpose, consumedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async markConsumed(userId: string, tenantId: string, purpose: PinPurpose): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.pinVerification.updateMany({
        where: { userId, tenantId, purpose, consumedAt: null, revokedAt: null },
        data: { consumedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { phoneVerified: true },
      }),
    ]);
  }

  private async recordAttempts(
    userId: string,
    tenantId: string,
    purpose: PinPurpose,
    attempts: number,
  ): Promise<void> {
    await this.prisma.pinVerification.updateMany({
      where: { userId, tenantId, purpose, consumedAt: null, revokedAt: null },
      data: { attempts },
    });
  }
}
