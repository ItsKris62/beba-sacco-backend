import {
  Injectable,
  Logger,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export interface DeviceInfo {
  userAgent: string;
  timezone?: string;
  screenRes?: string;
}

export interface ConsentAcceptDto {
  consentType: 'DATA_PROCESSING' | 'STATEMENT_EXPORT' | 'LOAN_TERMS';
  version?: string;
  ipAddress: string;
  userAgent?: string;
}

export interface SessionInfo {
  id: string;
  fingerprint: string;
  createdAt: Date;
  expiresAt: Date;
  isRevoked: boolean;
  isCurrent: boolean;
}

const MAX_CONCURRENT_SESSIONS = 3;
const REFRESH_TOKEN_TTL_DAYS = 7;

@Injectable()
export class SecurityService {
  private readonly logger = new Logger(SecurityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  // ─── Device Fingerprinting ─────────────────────────────────────────────────

  generateDeviceId(info: DeviceInfo): string {
    const raw = [
      info.userAgent ?? 'unknown',
      info.timezone ?? 'UTC',
      info.screenRes ?? '1920x1080',
    ].join('|');
    return createHash('sha256').update(raw).digest('hex');
  }

  // ─── Session Rotation ──────────────────────────────────────────────────────

  async createSession(
    userId: string,
    deviceInfo: DeviceInfo,
    tenantId: string,
    ipAddress?: string,
  ): Promise<string> {
    const deviceId = this.generateDeviceId(deviceInfo);
    const fingerprint = `${deviceInfo.userAgent?.substring(0, 50) ?? 'unknown'} | ${deviceInfo.timezone ?? 'UTC'}`;
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    const activeSessions = await this.prisma.refreshSession.count({
      where: { userId, isRevoked: false, expiresAt: { gt: new Date() } },
    });

    if (activeSessions >= MAX_CONCURRENT_SESSIONS) {
      const oldest = await this.prisma.refreshSession.findFirst({
        where: { userId, isRevoked: false },
        orderBy: { createdAt: 'asc' },
      });
      if (oldest) {
        await this.prisma.refreshSession.update({
          where: { id: oldest.id },
          data: { isRevoked: true },
        });
        this.logger.warn(`Revoked oldest session ${oldest.id} for user ${userId} (max sessions reached)`);
      }
    }

    const session = await this.prisma.refreshSession.create({
      data: { userId, deviceId, fingerprint, expiresAt },
    });

    await this.auditService.create({
      tenantId,
      userId,
      action: 'AUTH.SESSION.CREATED',
      resource: 'RefreshSession',
      resourceId: session.id,
      metadata: { deviceId, fingerprint },
      ipAddress,
    });

    return session.id;
  }

  async rotateSession(
    sessionId: string,
    userId: string,
    deviceInfo: DeviceInfo,
    tenantId: string,
    ipAddress?: string,
  ): Promise<string> {
    const session = await this.prisma.refreshSession.findUnique({
      where: { id: sessionId },
    });

    if (!session || session.userId !== userId) {
      throw new UnauthorizedException('Invalid session');
    }

    if (session.isRevoked) {
      await this.prisma.refreshSession.updateMany({
        where: { userId },
        data: { isRevoked: true },
      });
      await this.auditService.create({
        tenantId,
        userId,
        action: 'AUTH.SESSION.REUSE_DETECTED',
        resource: 'RefreshSession',
        resourceId: sessionId,
        metadata: { severity: 'HIGH' },
        ipAddress,
      });
      throw new UnauthorizedException('Session reuse detected – all sessions revoked');
    }

    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException('Session expired');
    }

    const expectedDeviceId = this.generateDeviceId(deviceInfo);
    if (session.deviceId !== expectedDeviceId) {
      await this.auditService.create({
        tenantId,
        userId,
        action: 'AUTH.SESSION.DEVICE_MISMATCH',
        resource: 'RefreshSession',
        resourceId: sessionId,
        metadata: { expected: session.deviceId, received: expectedDeviceId },
        ipAddress,
      });
      throw new ForbiddenException('Device fingerprint mismatch');
    }

    await this.prisma.refreshSession.update({
      where: { id: sessionId },
      data: { isRevoked: true },
    });

    const newSessionId = await this.createSession(userId, deviceInfo, tenantId, ipAddress);

    await this.auditService.create({
      tenantId,
      userId,
      action: 'AUTH.SESSION.ROTATED',
      resource: 'RefreshSession',
      resourceId: newSessionId,
      metadata: { oldSessionId: sessionId },
      ipAddress,
    });

    return newSessionId;
  }

  async revokeSession(
    sessionId: string,
    userId: string,
    tenantId: string,
    ipAddress?: string,
  ): Promise<void> {
    const session = await this.prisma.refreshSession.findUnique({
      where: { id: sessionId },
    });

    if (!session || session.userId !== userId) {
      throw new UnauthorizedException('Session not found');
    }

    await this.prisma.refreshSession.update({
      where: { id: sessionId },
      data: { isRevoked: true },
    });

    await this.auditService.create({
      tenantId,
      userId,
      action: 'AUTH.SESSION.REVOKED',
      resource: 'RefreshSession',
      resourceId: sessionId,
      metadata: {},
      ipAddress,
    });
  }

  async listSessions(userId: string, currentSessionId?: string): Promise<SessionInfo[]> {
    const sessions = await this.prisma.refreshSession.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    return sessions.map((s) => ({
      id: s.id,
      fingerprint: s.fingerprint,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      isRevoked: s.isRevoked,
      isCurrent: s.id === currentSessionId,
    }));
  }

  // ─── ODPC Consent Management ───────────────────────────────────────────────

  async acceptConsent(
    userId: string,
    dto: ConsentAcceptDto,
    tenantId: string,
  ): Promise<{ id: string; acceptedAt: Date }> {
    const version = dto.version ?? '1.0';

    const existing = await this.prisma.dataConsent.findUnique({
      where: {
        userId_consentType_version: { userId, consentType: dto.consentType, version },
      },
    });

    if (existing) {
      return { id: existing.id, acceptedAt: existing.acceptedAt };
    }

    const consent = await this.prisma.dataConsent.create({
      data: {
        userId,
        consentType: dto.consentType,
        version,
        acceptedAt: new Date(),
        ipAddress: dto.ipAddress,
        userAgent: dto.userAgent ?? null,
      },
    });

    await this.auditService.create({
      tenantId,
      userId,
      action: 'ODPC.CONSENT.ACCEPTED',
      resource: 'DataConsent',
      resourceId: consent.id,
      metadata: { consentType: dto.consentType, version, ipAddress: dto.ipAddress },
      ipAddress: dto.ipAddress,
    });

    this.logger.log(`Consent accepted: userId=${userId} type=${dto.consentType} v=${version}`);
    return { id: consent.id, acceptedAt: consent.acceptedAt };
  }

  async hasConsent(userId: string, consentType: string, version = '1.0'): Promise<boolean> {
    const consent = await this.prisma.dataConsent.findUnique({
      where: { userId_consentType_version: { userId, consentType, version } },
    });
    return !!consent;
  }

  async getUserConsents(userId: string): Promise<Array<{
    consentType: string;
    version: string;
    acceptedAt: Date;
    ipAddress: string;
  }>> {
    const consents = await this.prisma.dataConsent.findMany({
      where: { userId },
      orderBy: { acceptedAt: 'desc' },
    });

    return consents.map((c) => ({
      consentType: c.consentType,
      version: c.version,
      acceptedAt: c.acceptedAt,
      ipAddress: c.ipAddress,
    }));
  }

  async hasRequiredConsents(userId: string): Promise<boolean> {
    return this.hasConsent(userId, 'DATA_PROCESSING', '1.0');
  }
}
