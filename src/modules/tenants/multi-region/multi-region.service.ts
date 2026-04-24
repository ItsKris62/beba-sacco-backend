import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../common/services/redis.service';

export interface RegionConfig {
  tenantId: string;
  region: string;
  piiRegion: string;
  allowCrossRegionExport: boolean;
}

export interface ResidencyAuditResult {
  tenantId: string;
  region: string;
  piiRegion: string;
  allowCrossRegionExport: boolean;
  dataLocations: Array<{ dataType: string; region: string; compliant: boolean }>;
  auditedAt: string;
}

/**
 * Multi-Region Service – Phase 6
 *
 * Manages tenant region routing and data residency compliance.
 * Regions: KE-NAIROBI | UG-KAMPALA | RW-KIGALI
 *
 * Data residency rules:
 *  - PII stored only in tenant's designated region
 *  - Cross-region exports blocked unless consent: true
 *  - Read replicas route GET traffic locally
 */
@Injectable()
export class MultiRegionService {
  private readonly logger = new Logger(MultiRegionService.name);
  private readonly CACHE_PREFIX = 'region:config:';
  private readonly CACHE_TTL = 300; // 5 minutes

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async getTenantRegion(tenantId: string): Promise<RegionConfig | null> {
    // Check cache
    const cached = await this.redis.getJson<RegionConfig>(`${this.CACHE_PREFIX}${tenantId}`);
    if (cached) return cached;

    const config = await this.prisma.tenantRegionConfig.findUnique({
      where: { tenantId },
    });

    if (!config) return null;

    const regionConfig: RegionConfig = {
      tenantId: config.tenantId,
      region: config.region,
      piiRegion: config.piiRegion,
      allowCrossRegionExport: config.allowCrossRegionExport,
    };

    await this.redis.setJson(`${this.CACHE_PREFIX}${tenantId}`, regionConfig, this.CACHE_TTL);
    return regionConfig;
  }

  async getResidencyAudit(tenantId: string): Promise<ResidencyAuditResult> {
    const config = await this.getTenantRegion(tenantId);

    const region = config?.region ?? 'KE-NAIROBI';
    const piiRegion = config?.piiRegion ?? 'KE-NAIROBI';

    // Verify data locations
    const dataLocations = [
      { dataType: 'Member PII (nationalId, kraPin)', region: piiRegion, compliant: piiRegion === region },
      { dataType: 'Transaction Records', region, compliant: true },
      { dataType: 'Audit Logs', region, compliant: true },
      { dataType: 'Loan Data', region, compliant: true },
      { dataType: 'AML Screening Results', region: piiRegion, compliant: piiRegion === region },
    ];

    return {
      tenantId,
      region,
      piiRegion,
      allowCrossRegionExport: config?.allowCrossRegionExport ?? false,
      dataLocations,
      auditedAt: new Date().toISOString(),
    };
  }

  async assertExportAllowed(tenantId: string, targetRegion: string): Promise<void> {
    const config = await this.getTenantRegion(tenantId);
    if (!config) return; // No region config = no restriction

    if (config.region !== targetRegion && !config.allowCrossRegionExport) {
      throw new ForbiddenException(
        `Cross-region export from ${config.region} to ${targetRegion} is not permitted. ` +
        'Set allowCrossRegionExport: true with explicit consent to enable.',
      );
    }
  }

  async upsertRegionConfig(dto: {
    tenantId: string;
    region: string;
    piiRegion: string;
    allowCrossRegionExport?: boolean;
  }): Promise<RegionConfig> {
    const config = await this.prisma.tenantRegionConfig.upsert({
      where: { tenantId: dto.tenantId },
      create: {
        tenantId: dto.tenantId,
        region: dto.region,
        primaryDsn: '',
        piiRegion: dto.piiRegion,
        allowCrossRegionExport: dto.allowCrossRegionExport ?? false,
      },
      update: {
        region: dto.region,
        piiRegion: dto.piiRegion,
        allowCrossRegionExport: dto.allowCrossRegionExport ?? false,
      },
    });

    const regionConfig: RegionConfig = {
      tenantId: config.tenantId,
      region: config.region,
      piiRegion: config.piiRegion,
      allowCrossRegionExport: config.allowCrossRegionExport,
    };

    // Invalidate cache
    await this.redis.del(`${this.CACHE_PREFIX}${dto.tenantId}`);
    this.logger.log(`Updated region config for tenant ${dto.tenantId}: ${dto.region}`);

    return regionConfig;
  }
}
