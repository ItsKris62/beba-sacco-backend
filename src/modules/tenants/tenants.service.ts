import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateTenantSettingsDto } from './dto/update-tenant-settings.dto';

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSettings(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');

    const settings = (tenant.settings as Record<string, unknown>) || {};
    return {
      maxConcurrentGuarantees: (settings.maxConcurrentGuarantees as number) ?? 3,
    };
  }

  async updateSettings(tenantId: string, dto: UpdateTenantSettingsDto) {
    const currentSettings = await this.getSettings(tenantId);
    
    const newSettings = { ...currentSettings, ...dto };

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { settings: newSettings },
    });

    return newSettings;
  }
}