import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

export interface FingerprintResult {
  sessionId: string;
  isNewDevice: boolean;
  isGeoHop: boolean;
}

/**
 * DeviceFingerprintService – Phase 4
 *
 * Records login sessions keyed by (userId, ipHash, userAgent).
 * Flags:
 *   - New device: first time this ipHash + userAgent combination is seen for this user
 *   - Geo-hop: same user logging in from a different IP within 1 hour of a prior session
 */
@Injectable()
export class DeviceFingerprintService {
  private readonly logger = new Logger(DeviceFingerprintService.name);

  constructor(private readonly prisma: PrismaService) {}

  async recordLogin(params: {
    userId: string;
    tenantId: string;
    ip: string;
    userAgent?: string;
    geoHint?: string;
  }): Promise<FingerprintResult> {
    const { userId, tenantId, ip, userAgent, geoHint } = params;
    const ipHash = createHash('sha256').update(ip).digest('hex');

    // Look for an existing session with the same fingerprint
    const existingSession = await this.prisma.loginSession.findFirst({
      where: { userId, tenantId, ipHash },
    });

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    // Geo-hop: user already has a recent active session from a DIFFERENT IP
    const recentDifferentIp = await this.prisma.loginSession.findFirst({
      where: {
        userId,
        tenantId,
        ipHash: { not: ipHash },
        isActive: true,
        lastSeen: { gte: oneHourAgo },
      },
    });

    const isGeoHop = !!recentDifferentIp;
    const isNewDevice = !existingSession;

    if (isGeoHop) {
      this.logger.warn(
        `Geo-hop detected: userId=${userId} newIp=${ipHash.slice(0, 8)}… prevIp=${recentDifferentIp!.ipHash.slice(0, 8)}…`,
      );
    }

    let sessionId: string;

    if (existingSession) {
      await this.prisma.loginSession.update({
        where: { id: existingSession.id },
        data: { lastSeen: new Date(), isActive: true },
      });
      sessionId = existingSession.id;
    } else {
      const session = await this.prisma.loginSession.create({
        data: { userId, tenantId, ipHash, userAgent, geoHint, isActive: true },
      });
      sessionId = session.id;
    }

    return { sessionId, isNewDevice, isGeoHop };
  }

  async deactivateUserSessions(userId: string, tenantId: string): Promise<void> {
    await this.prisma.loginSession.updateMany({
      where: { userId, tenantId },
      data: { isActive: false },
    });
  }
}
