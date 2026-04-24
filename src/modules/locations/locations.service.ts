import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';

const CACHE_TTL = 86_400; // 24 hours
const COUNTIES_KEY = 'locations:counties';
const CONSTITUENCIES_KEY = (countyId: string) => `locations:constituencies:${countyId}`;
const WARDS_KEY = (constituencyId: string) => `locations:wards:${constituencyId}`;

export interface CountyDto {
  id: string;
  code: string;
  name: string;
}

export interface ConstituencyDto {
  id: string;
  code: string;
  name: string;
  countyId: string;
}

export interface WardDto {
  id: string;
  code: string;
  name: string;
  constituencyId: string;
}

/**
 * LocationsService
 *
 * Serves the scoped location hierarchy (Nairobi + Western Kenya).
 * All results are Redis-cached with a 24-hour TTL to minimise DB load.
 * Cache is populated lazily on first request; seeded data is the source of truth.
 *
 * TODO: Sprint 2 – add cache invalidation endpoint for SUPER_ADMIN when new
 *   counties/wards are added via admin panel.
 */
@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ─── Counties ────────────────────────────────────────────────────────────────

  async getCounties(): Promise<CountyDto[]> {
    const cached = await this.redis.getJson<CountyDto[]>(COUNTIES_KEY);
    if (cached) return cached;

    const counties = await this.prisma.county.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    });

    await this.redis.setJson(COUNTIES_KEY, counties, CACHE_TTL);
    this.logger.debug(`Counties cache populated: ${counties.length} records`);
    return counties;
  }

  // ─── Constituencies ───────────────────────────────────────────────────────────

  async getConstituencies(countyId: string): Promise<ConstituencyDto[]> {
    const key = CONSTITUENCIES_KEY(countyId);
    const cached = await this.redis.getJson<ConstituencyDto[]>(key);
    if (cached) return cached;

    const constituencies = await this.prisma.constituency.findMany({
      where: { countyId },
      select: { id: true, code: true, name: true, countyId: true },
      orderBy: { name: 'asc' },
    });

    await this.redis.setJson(key, constituencies, CACHE_TTL);
    return constituencies;
  }

  // ─── Wards ────────────────────────────────────────────────────────────────────

  async getWards(constituencyId: string): Promise<WardDto[]> {
    const key = WARDS_KEY(constituencyId);
    const cached = await this.redis.getJson<WardDto[]>(key);
    if (cached) return cached;

    const wards = await this.prisma.ward.findMany({
      where: { constituencyId },
      select: { id: true, code: true, name: true, constituencyId: true },
      orderBy: { name: 'asc' },
    });

    await this.redis.setJson(key, wards, CACHE_TTL);
    return wards;
  }

  // ─── Cache Warm-up ────────────────────────────────────────────────────────────

  /**
   * Pre-warm the entire location hierarchy into Redis.
   * Called by the seed script after inserting location data.
   */
  async warmCache(): Promise<void> {
    this.logger.log('Warming location cache…');

    const counties = await this.prisma.county.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    });
    await this.redis.setJson(COUNTIES_KEY, counties, CACHE_TTL);

    for (const county of counties) {
      const constituencies = await this.prisma.constituency.findMany({
        where: { countyId: county.id },
        select: { id: true, code: true, name: true, countyId: true },
        orderBy: { name: 'asc' },
      });
      await this.redis.setJson(CONSTITUENCIES_KEY(county.id), constituencies, CACHE_TTL);

      for (const c of constituencies) {
        const wards = await this.prisma.ward.findMany({
          where: { constituencyId: c.id },
          select: { id: true, code: true, name: true, constituencyId: true },
          orderBy: { name: 'asc' },
        });
        await this.redis.setJson(WARDS_KEY(c.id), wards, CACHE_TTL);
      }
    }

    this.logger.log(`Location cache warmed: ${counties.length} counties`);
  }
}
