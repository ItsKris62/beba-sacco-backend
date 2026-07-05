import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { AccountingService } from '../accounting/accounting.service';
import { UpdateTenantSettingsDto } from './dto/update-tenant-settings.dto';
import { RequestLogoUploadUrlDto } from './dto/request-logo-upload-url.dto';
import { CreateTenantDto } from './dto/create-tenant.dto';

const PROFILE_FIELDS = ['name', 'contactEmail', 'contactPhone', 'address', 'logoUrl'] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
    private readonly accounting: AccountingService,
  ) {}

  /**
   * Provision a brand-new tenant: creates the Tenant row, then seeds the
   * default chart of accounts + FOSA/BOSA balance policies so the tenant is
   * immediately ready to open member accounts and post ledger entries.
   *
   * GL/policy seeding runs after the Tenant row commits (separate idempotent
   * calls, not one DB transaction) — if seeding fails partway, it is safe to
   * re-run via accounting.provisionTenantAccounting(tenant.id) since both
   * seed methods upsert on (tenantId, code) / (tenantId, accountType).
   */
  async create(dto: CreateTenantDto, actorId?: string) {
    let tenant;
    try {
      tenant = await this.prisma.tenant.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          schemaName: dto.schemaName,
          contactEmail: dto.contactEmail,
          contactPhone: dto.contactPhone,
          address: dto.address,
          logoUrl: dto.logoUrl,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A tenant with this slug or schemaName already exists');
      }
      throw e;
    }

    const provisioning = await this.accounting.provisionTenantAccounting(tenant.id);
    this.logger.log(
      `Provisioned tenant ${tenant.slug} (${tenant.id}): ` +
        `${provisioning.glAccountsSeeded} GL accounts, ${provisioning.policiesSeeded} account-type policies`,
    );

    this.audit
      .create({
        tenantId: tenant.id,
        actorId,
        action: 'TENANT.CREATED',
        entityType: 'Tenant',
        entityId: tenant.id,
        newValue: { name: tenant.name, slug: tenant.slug, contactEmail: tenant.contactEmail },
        metadata: provisioning,
      })
      .catch((e: unknown) => this.logger.error('Audit write failed for TENANT.CREATED', e));

    return { ...tenant, provisioning };
  }

  async getSettings(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        settings: true,
        name: true,
        contactEmail: true,
        contactPhone: true,
        address: true,
        logoUrl: true,
      },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');

    const settings = (tenant.settings as Record<string, unknown>) || {};
    return {
      maxConcurrentGuarantees: (settings.maxConcurrentGuarantees as number) ?? 3,
      name: tenant.name,
      contactEmail: tenant.contactEmail,
      contactPhone: tenant.contactPhone,
      address: tenant.address,
      logoUrl: tenant.logoUrl,
      security: settings.security as Record<string, unknown> | undefined,
    };
  }

  /** Safe, public subset of tenant identity for unauthenticated marketing pages. */
  async getPublicInfo(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        contactEmail: true,
        contactPhone: true,
        address: true,
        logoUrl: true,
      },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');
    return tenant;
  }

  async updateSettings(
    tenantId: string,
    dto: UpdateTenantSettingsDto,
    actorId: string,
    ipAddress?: string,
  ) {
    const existing = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        settings: true,
        name: true,
        contactEmail: true,
        contactPhone: true,
        address: true,
        logoUrl: true,
      },
    });
    if (!existing) throw new NotFoundException('Tenant not found');

    const currentSettings = (existing.settings as Record<string, unknown>) || {};
    const newSettings = {
      ...currentSettings,
      ...(dto.maxConcurrentGuarantees !== undefined && {
        maxConcurrentGuarantees: dto.maxConcurrentGuarantees,
      }),
      ...(dto.security !== undefined && {
        security: {
          ...(currentSettings.security as Record<string, unknown> || {}),
          ...dto.security,
          ...(dto.security.passwordPolicy !== undefined && {
            passwordPolicy: {
              ...((currentSettings.security as any)?.passwordPolicy || {}),
              ...dto.security.passwordPolicy,
            },
          }),
        },
      }),
    };

    const profileUpdates: Partial<Record<ProfileField, string>> = {};
    for (const field of PROFILE_FIELDS) {
      if (dto[field] !== undefined) {
        profileUpdates[field] = dto[field] as string;
      }
    }

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        settings: newSettings,
        ...profileUpdates,
      },
    });

    await this.redis.del(`tenant:config:${tenantId}`);

    const changedFields = Object.keys(dto);
    this.audit
      .create({
        tenantId,
        actorId,
        action: 'TENANT.SETTINGS_UPDATE',
        entityType: 'Tenant',
        entityId: tenantId,
        oldValue: {
          maxConcurrentGuarantees: currentSettings.maxConcurrentGuarantees ?? 3,
          security: currentSettings.security,
          name: existing.name,
          contactEmail: existing.contactEmail,
          contactPhone: existing.contactPhone,
          address: existing.address,
          logoUrl: existing.logoUrl,
        },
        newValue: {
          maxConcurrentGuarantees: newSettings.maxConcurrentGuarantees ?? 3,
          security: newSettings.security,
          ...profileUpdates,
        },
        metadata: { changedFields },
        ipAddress,
      })
      .catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error('Audit write failed for TENANT.SETTINGS_UPDATE', e);
      });

    return this.getSettings(tenantId);
  }

  async requestLogoUploadUrl(tenantId: string, dto: RequestLogoUploadUrlDto) {
    const ext = dto.contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
    const objectKey = `tenants/${tenantId}/branding/${uuidv4()}.${ext}`;

    const { uploadUrl, expiresIn } = await this.storage.getUploadUrlForKey({
      objectKey,
      contentType: dto.contentType,
    });

    const publicBaseUrl = this.config.get<string>('app.r2.publicUrl', '').replace(/\/$/, '');
    const publicUrl = `${publicBaseUrl}/${objectKey}`;

    return { uploadUrl, objectKey, publicUrl, expiresIn };
  }
}
