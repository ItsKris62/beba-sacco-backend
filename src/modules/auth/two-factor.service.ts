import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { generateSecret, generateURI, verify } from 'otplib';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../zero-trust/encryption/encryption.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);


  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly auditService: AuditService,
  ) {}

  async generateSecret(userId: string, email: string) {
    const secret = generateSecret();
    const otpauthUrl = generateURI({ issuer: 'Beba SACCO', label: email, secret });
    return { secret, otpauthUrl };
  }

  async verifyAndEnable(userId: string, tenantId: string, secret: string, token: string, ipAddress?: string) {
    const isValid = await verify({ token, secret });
    if (!isValid) {
      throw new BadRequestException('Invalid TOTP token');
    }

    const payload = await this.encryption.encrypt(secret, tenantId);
    const encryptedSecret = JSON.stringify(payload);
    
    // Generate 10 backup codes
    const backupCodesPlain = Array.from({ length: 10 }, () => randomBytes(4).toString('hex'));
    const backupCodesHashed = await Promise.all(backupCodesPlain.map(code => argon2.hash(code)));

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        totpSecret: encryptedSecret,
        twoFactorEnabled: true,
        backupCodes: backupCodesHashed,
        totpEnrolledAt: new Date(),
      },
    });

    await this.auditService.create({
      tenantId,
      userId,
      action: 'AUTH.2FA_ENABLED',
      resource: 'User',
      resourceId: userId,
      ipAddress,
    });

    return { backupCodes: backupCodesPlain };
  }

  async verifyToken(userId: string, token: string, tenantId: string, ipAddress?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId, tenantId } });
    if (!user || !user.totpSecret || !user.twoFactorEnabled) {
      throw new BadRequestException('2FA not enabled for this user');
    }

    const payload = JSON.parse(user.totpSecret);
    const secret = await this.encryption.decrypt(payload, tenantId);
    
    const isValid = await verify({ token, secret });
    if (!isValid) {
      throw new BadRequestException('Invalid TOTP token');
    }

    return true;
  }

  async verifyBackupCode(userId: string, tenantId: string, code: string, ipAddress?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.backupCodes || user.backupCodes.length === 0) {
      throw new BadRequestException('Invalid backup code');
    }

    for (let i = 0; i < user.backupCodes.length; i++) {
      const isValid = await argon2.verify(user.backupCodes[i], code);
      if (isValid) {
        // Consume backup code
        const newCodes = [...user.backupCodes];
        newCodes.splice(i, 1);
        await this.prisma.user.update({
          where: { id: userId },
          data: { backupCodes: newCodes },
        });

        await this.auditService.create({
          tenantId,
          userId,
          action: 'AUTH.2FA_BACKUP_CODE_USED',
          resource: 'User',
          resourceId: userId,
          metadata: { remaining: newCodes.length },
          ipAddress,
        });
        return true;
      }
    }
    throw new BadRequestException('Invalid backup code');
  }

  async regenerateBackupCodes(userId: string, tenantId: string, ipAddress?: string) {
    const backupCodesPlain = Array.from({ length: 10 }, () => randomBytes(4).toString('hex'));
    const backupCodesHashed = await Promise.all(backupCodesPlain.map(code => argon2.hash(code)));

    await this.prisma.user.update({
      where: { id: userId },
      data: { backupCodes: backupCodesHashed },
    });

    await this.auditService.create({
      tenantId,
      userId,
      action: 'AUTH.2FA_BACKUP_CODES_REGENERATED',
      resource: 'User',
      resourceId: userId,
      ipAddress,
    });

    return { backupCodes: backupCodesPlain };
  }

  async disable2FA(userId: string, tenantId: string, ipAddress?: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        totpSecret: null,
        backupCodes: [],
        totpEnrolledAt: null,
      },
    });

    await this.auditService.create({
      tenantId,
      userId,
      action: 'AUTH.2FA_DISABLED',
      resource: 'User',
      resourceId: userId,
      ipAddress,
    });
  }
}
