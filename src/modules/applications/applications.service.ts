import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ApplicationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateApplicationDto } from './dto/create-application.dto';

const APPLICATION_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  idNumber: true,
  phoneNumber: true,
  stageName: true,
  position: true,
  status: true,
  documentUrl: true,
  reviewedBy: true,
  reviewNotes: true,
  tenantId: true,
  createdAt: true,
  updatedAt: true,
  ward: {
    select: {
      id: true,
      name: true,
      constituency: {
        select: {
          id: true,
          name: true,
          county: { select: { id: true, name: true } },
        },
      },
    },
  },
} as const;

/**
 * ApplicationsService
 *
 * Manages the pre-onboarding form queue.
 * Approval is delegated to OnboardingService (transactional).
 *
 * Business rules:
 *  - idNumber and phoneNumber must be unique across the tenant
 *  - Only SUBMITTED/PENDING_REVIEW applications can be approved/rejected
 *  - Approval atomically creates User + Member + StageAssignment + FOSA/BOSA accounts
 */
@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─── SUBMIT ──────────────────────────────────────────────────────────────────

  async create(
    dto: CreateApplicationDto,
    tenantId: string,
    actorId: string,
    ipAddress?: string,
  ) {
    // Validate ward exists
    const ward = await this.prisma.ward.findUnique({ where: { id: dto.wardId } });
    if (!ward) throw new BadRequestException(`Ward '${dto.wardId}' not found`);

    // Duplicate check: idNumber within tenant
    const dupId = await this.prisma.memberApplication.findFirst({
      where: { tenantId, idNumber: dto.idNumber },
      select: { id: true, status: true },
    });
    if (dupId) {
      throw new ConflictException(
        `An application with ID number ${dto.idNumber} already exists (status: ${dupId.status})`,
      );
    }

    // Duplicate check: phoneNumber within tenant
    const dupPhone = await this.prisma.memberApplication.findFirst({
      where: { tenantId, phoneNumber: dto.phoneNumber },
      select: { id: true, status: true },
    });
    if (dupPhone) {
      throw new ConflictException(
        `An application with phone ${dto.phoneNumber} already exists (status: ${dupPhone.status})`,
      );
    }

    // Also check if a User with this idNumber or phoneNumber already exists
    const existingUser = await this.prisma.user.findFirst({
      where: {
        tenantId,
        OR: [
          { idNumber: dto.idNumber },
          { phoneNumber: dto.phoneNumber },
        ],
      },
      select: { id: true },
    });
    if (existingUser) {
      throw new ConflictException('A member with this ID number or phone number already exists');
    }

    const application = await this.prisma.memberApplication.create({
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        idNumber: dto.idNumber,
        phoneNumber: dto.phoneNumber,
        stageName: dto.stageName,
        position: dto.position ?? 'MEMBER',
        wardId: dto.wardId,
        documentUrl: dto.documentUrl,
        tenantId,
        status: ApplicationStatus.SUBMITTED,
      },
      select: APPLICATION_SELECT,
    });

    await this.auditSafe({
      tenantId,
      userId: actorId,
      action: 'APPLICATION.SUBMIT',
      resource: 'MemberApplication',
      resourceId: application.id,
      metadata: {
        idNumber: dto.idNumber,
        phoneNumber: dto.phoneNumber,
        stageName: dto.stageName,
      },
      ipAddress,
    });

    this.logger.log(`Application submitted: ${application.id} for ${dto.firstName} ${dto.lastName}`);
    return application;
  }

  // ─── LIST PENDING ─────────────────────────────────────────────────────────────

  async findPending(
    tenantId: string,
    opts: { page?: number; limit?: number; status?: ApplicationStatus } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = {
      tenantId,
      status: opts.status ?? { in: [ApplicationStatus.SUBMITTED, ApplicationStatus.PENDING_REVIEW] },
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.memberApplication.findMany({
        where,
        select: APPLICATION_SELECT,
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.memberApplication.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ─── FIND ONE ─────────────────────────────────────────────────────────────────

  async findOne(id: string, tenantId: string) {
    const app = await this.prisma.memberApplication.findFirst({
      where: { id, tenantId },
      select: APPLICATION_SELECT,
    });
    if (!app) throw new NotFoundException('Application not found');
    return app;
  }

  // ─── MARK PENDING REVIEW ──────────────────────────────────────────────────────

  async markPendingReview(id: string, tenantId: string, actorId: string) {
    const app = await this.findOne(id, tenantId);
    if (app.status !== ApplicationStatus.SUBMITTED) {
      throw new BadRequestException(`Application is already in status: ${app.status}`);
    }

    return this.prisma.memberApplication.update({
      where: { id },
      data: { status: ApplicationStatus.PENDING_REVIEW, reviewedBy: actorId },
      select: APPLICATION_SELECT,
    });
  }

  // ─── PRIVATE HELPERS ──────────────────────────────────────────────────────────

  private async auditSafe(params: Parameters<AuditService['create']>[0]): Promise<void> {
    await this.audit
      .create(params)
      .catch((e: unknown) =>
        this.logger.error('Audit write failed (non-fatal)', e instanceof Error ? e.stack : e),
      );
  }
}
