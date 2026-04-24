import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export interface ConsentAcceptDto {
  consentType: 'DATA_PROCESSING' | 'STATEMENT_EXPORT' | 'LOAN_TERMS';
  version?: string;
  ipAddress: string;
  userAgent?: string;
}

@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

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
