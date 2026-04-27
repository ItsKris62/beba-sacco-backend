import {
  Injectable, Logger, NotFoundException,
  ConflictException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateStageDto, UpdateStageDto, AssignStagePositionDto } from './dto/create-stage.dto';

const STAGE_SELECT = {
  id: true,
  name: true,
  tenantId: true,
  createdAt: true,
  ward: {
    select: {
      id: true,
      name: true,
      constituency: {
        select: { id: true, name: true, county: { select: { id: true, name: true } } },
      },
    },
  },
  _count: { select: { assignments: true } },
} as const;

@Injectable()
export class StagesService {
  private readonly logger = new Logger(StagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─── CREATE ──────────────────────────────────────────────────────────────────

  async create(dto: CreateStageDto, tenantId: string, actorId: string, ipAddress?: string) {
    const ward = await this.prisma.ward.findUnique({ where: { id: dto.wardId } });
    if (!ward) throw new BadRequestException(`Ward '${dto.wardId}' not found`);

    const existing = await this.prisma.stage.findFirst({
      where: { name: dto.name, wardId: dto.wardId, tenantId },
    });
    if (existing) throw new ConflictException(`Stage '${dto.name}' already exists in this ward`);

    const stage = await this.prisma.stage.create({
      data: { name: dto.name, wardId: dto.wardId, tenantId },
      select: STAGE_SELECT,
    });

    await this.auditSafe({
      tenantId, userId: actorId,
      action: 'STAGE.CREATE', resource: 'Stage', resourceId: stage.id,
      metadata: { name: dto.name, wardId: dto.wardId },
      ipAddress,
    });

    return stage;
  }

  // ─── LIST ────────────────────────────────────────────────────────────────────

  async findAll(tenantId: string, opts: { page?: number; limit?: number } = {}) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const skip = (page - 1) * limit;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.stage.findMany({
        where: { tenantId },
        select: STAGE_SELECT,
        skip,
        take: limit,
        orderBy: { name: 'asc' },
      }),
      this.prisma.stage.count({ where: { tenantId } }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ─── UPDATE ──────────────────────────────────────────────────────────────────

  async update(
    id: string,
    dto: UpdateStageDto,
    tenantId: string,
    actorId: string,
    ipAddress?: string,
  ) {
    const stage = await this.prisma.stage.findFirst({ where: { id, tenantId } });
    if (!stage) throw new NotFoundException('Stage not found');

    // If renaming, check for duplicate in same ward
    if (dto.name && dto.name !== stage.name) {
      const wardId = dto.wardId ?? stage.wardId;
      const existing = await this.prisma.stage.findFirst({
        where: { name: dto.name, wardId, tenantId, NOT: { id } },
      });
      if (existing) throw new ConflictException(`Stage '${dto.name}' already exists in this ward`);
    }

    // If changing ward, validate it exists
    if (dto.wardId && dto.wardId !== stage.wardId) {
      const ward = await this.prisma.ward.findUnique({ where: { id: dto.wardId } });
      if (!ward) throw new BadRequestException(`Ward '${dto.wardId}' not found`);
    }

    const updated = await this.prisma.stage.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.wardId ? { wardId: dto.wardId } : {}),
      },
      select: STAGE_SELECT,
    });

    await this.auditSafe({
      tenantId, userId: actorId,
      action: 'STAGE.UPDATE', resource: 'Stage', resourceId: id,
      metadata: { name: dto.name, wardId: dto.wardId },
      ipAddress,
    });

    return updated;
  }

  // ─── DELETE ──────────────────────────────────────────────────────────────────

  async remove(id: string, tenantId: string, actorId: string, ipAddress?: string) {
    const stage = await this.prisma.stage.findFirst({
      where: { id, tenantId },
      select: { ...STAGE_SELECT, _count: { select: { assignments: true } } },
    });
    if (!stage) throw new NotFoundException('Stage not found');

    if (stage._count.assignments > 0) {
      throw new BadRequestException(
        `Cannot delete stage with ${stage._count.assignments} active assignment(s). Remove assignments first.`,
      );
    }

    await this.prisma.stage.delete({ where: { id } });

    await this.auditSafe({
      tenantId, userId: actorId,
      action: 'STAGE.DELETE', resource: 'Stage', resourceId: id,
      metadata: { name: stage.name },
      ipAddress,
    });

    return { success: true, message: 'Stage deleted successfully' };
  }

  // ─── FIND ONE ─────────────────────────────────────────────────────────────────

  async findOne(id: string, tenantId: string) {
    const stage = await this.prisma.stage.findFirst({
      where: { id, tenantId },
      select: {
        ...STAGE_SELECT,
        assignments: {
          where: { isActive: true },
          select: {
            id: true,
            position: true,
            joinedAt: true,
            user: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        },
      },
    });
    if (!stage) throw new NotFoundException('Stage not found');
    return stage;
  }

  // ─── LIST BY COUNTY / CONSTITUENCY ───────────────────────────────────────────

  async findByLocation(
    tenantId: string,
    opts: { page?: number; limit?: number; countyId?: string; constituencyId?: string; wardId?: string; search?: string } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
    const skip = (page - 1) * limit;

    // Build ward filter based on location hierarchy
    let wardFilter: { id?: string; constituencyId?: string; constituency?: { countyId: string } } | undefined;
    if (opts.wardId) {
      wardFilter = { id: opts.wardId };
    } else if (opts.constituencyId) {
      wardFilter = { constituencyId: opts.constituencyId };
    } else if (opts.countyId) {
      wardFilter = { constituency: { countyId: opts.countyId } };
    }

    const where = {
      tenantId,
      ...(opts.search ? { name: { contains: opts.search, mode: 'insensitive' as const } } : {}),
      ...(wardFilter ? { ward: wardFilter } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.stage.findMany({
        where,
        select: STAGE_SELECT,
        skip,
        take: limit,
        orderBy: { name: 'asc' },
      }),
      this.prisma.stage.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ─── ASSIGN POSITION ─────────────────────────────────────────────────────────

  async assignPosition(
    stageId: string,
    dto: AssignStagePositionDto,
    tenantId: string,
    actorId: string,
    ipAddress?: string,
  ) {
    const stage = await this.prisma.stage.findFirst({ where: { id: stageId, tenantId } });
    if (!stage) throw new NotFoundException('Stage not found');

    const user = await this.prisma.user.findFirst({
      where: { id: dto.userId, tenantId },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!user) throw new NotFoundException('User not found in this tenant');

    // If assigning CHAIRMAN or SECRETARY, deactivate existing holder
    if (dto.position === 'CHAIRMAN' || dto.position === 'SECRETARY') {
      await this.prisma.stageAssignment.updateMany({
        where: { stageId, position: dto.position as never, isActive: true },
        data: { isActive: false },
      });
    }

    const assignment = await this.prisma.stageAssignment.upsert({
      where: { userId_stageId: { userId: dto.userId, stageId } },
      create: {
        userId: dto.userId,
        stageId,
        position: (dto.position ?? 'MEMBER') as never,
        isActive: true,
      },
      update: {
        position: (dto.position ?? 'MEMBER') as never,
        isActive: true,
      },
      select: {
        id: true, position: true, joinedAt: true,
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    await this.auditSafe({
      tenantId, userId: actorId,
      action: 'STAGE.ASSIGN_POSITION', resource: 'StageAssignment', resourceId: assignment.id,
      metadata: { stageId, userId: dto.userId, position: dto.position },
      ipAddress,
    });

    return assignment;
  }

  private async auditSafe(params: Parameters<AuditService['create']>[0]): Promise<void> {
    await this.audit.create(params).catch((e: unknown) =>
      this.logger.error('Audit write failed', e instanceof Error ? e.stack : e),
    );
  }
}
