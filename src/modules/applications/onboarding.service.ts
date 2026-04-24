import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ApplicationStatus, AccountType, KycStatus, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ApproveApplicationDto, RejectApplicationDto } from './dto/review-application.dto';

/**
 * OnboardingService
 *
 * Handles the transactional approval of member applications.
 *
 * Approval flow (atomic $transaction):
 *  1. Validate application is in SUBMITTED or PENDING_REVIEW state
 *  2. Check for duplicate idNumber / phoneNumber on User table
 *  3. Generate member number (tenant-scoped counter)
 *  4. Create User (mustChangePassword = true)
 *  5. Create Member profile (kycStatus = APPROVED)
 *  6. Create FOSA account
 *  7. Create BOSA account
 *  8. Create or find Stage, then create StageAssignment
 *  9. Update MemberApplication.status = APPROVED
 * 10. Audit log
 *
 * Rollback: any failure in steps 1–9 rolls back the entire transaction.
 *
 * TODO: Sprint 2 – enqueue welcome SMS/email notification after approval
 * TODO: Sprint 2 – Excel/CSV bulk import (deferred)
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─── APPROVE ─────────────────────────────────────────────────────────────────

  async approve(
    applicationId: string,
    tenantId: string,
    actorId: string,
    dto: ApproveApplicationDto,
    ipAddress?: string,
  ) {
    // Load application
    const app = await this.prisma.memberApplication.findFirst({
      where: { id: applicationId, tenantId },
      include: { ward: true },
    });

    if (!app) throw new NotFoundException('Application not found');

    if (
      app.status !== ApplicationStatus.SUBMITTED &&
      app.status !== ApplicationStatus.PENDING_REVIEW
    ) {
      throw new BadRequestException(
        `Cannot approve application in status: ${app.status}. Only SUBMITTED or PENDING_REVIEW applications can be approved.`,
      );
    }

    // Duplicate guard on User table (belt-and-suspenders)
    const dupUser = await this.prisma.user.findFirst({
      where: {
        tenantId,
        OR: [{ idNumber: app.idNumber }, { phoneNumber: app.phoneNumber }],
      },
      select: { id: true },
    });
    if (dupUser) {
      throw new ConflictException(
        'A user with this ID number or phone number already exists in this tenant',
      );
    }

    // Derive email: use provided or generate from idNumber
    const email =
      dto.email?.toLowerCase() ??
      `member.${app.idNumber}@${tenantId.slice(0, 8)}.beba.local`;

    // Check email uniqueness
    const dupEmail = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (dupEmail) {
      throw new ConflictException(
        `Email ${email} is already registered. Provide a different email in the approval request.`,
      );
    }

    // Generate temporary password
    const tempPassword =
      dto.temporaryPassword ?? this.generateTempPassword();
    const passwordHash = await argon2.hash(tempPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    // ── Atomic transaction ────────────────────────────────────────────────────
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Increment tenant member counter
      const counter = await tx.tenantCounter.upsert({
        where: { tenantId },
        create: { tenantId, memberSeq: 1, accountSeq: 2 },
        update: { memberSeq: { increment: 1 }, accountSeq: { increment: 2 } },
      });

      const memberNumber = `M-${String(counter.memberSeq).padStart(6, '0')}`;
      const fosaAccNum = `ACC-FOSA-${String(counter.accountSeq - 1).padStart(6, '0')}`;
      const bosaAccNum = `ACC-BOSA-${String(counter.accountSeq).padStart(6, '0')}`;

      // 2. Create User
      const user = await tx.user.create({
        data: {
          tenantId,
          email,
          passwordHash,
          firstName: app.firstName,
          lastName: app.lastName,
          phone: app.phoneNumber,
          phoneNumber: app.phoneNumber,
          idNumber: app.idNumber,
          wardId: app.wardId,
          role: UserRole.MEMBER,
          mustChangePassword: true,
          userStatus: 'ACTIVE',
        },
        select: { id: true, email: true, firstName: true, lastName: true },
      });

      // 3. Create Member profile
      const member = await tx.member.create({
        data: {
          tenantId,
          userId: user.id,
          memberNumber,
          nationalId: app.idNumber,
          kycStatus: KycStatus.APPROVED,
          kycReviewedAt: new Date(),
          kycReviewedByUserId: actorId,
          isActive: true,
        },
        select: { id: true, memberNumber: true },
      });

      // 4. Create FOSA account
      const fosaAccount = await tx.account.create({
        data: {
          tenantId,
          memberId: member.id,
          accountNumber: fosaAccNum,
          accountType: AccountType.FOSA,
          balance: 0,
          isActive: true,
        },
        select: { id: true, accountNumber: true, accountType: true },
      });

      // 5. Create BOSA account
      const bosaAccount = await tx.account.create({
        data: {
          tenantId,
          memberId: member.id,
          accountNumber: bosaAccNum,
          accountType: AccountType.BOSA,
          balance: 0,
          isActive: true,
        },
        select: { id: true, accountNumber: true, accountType: true },
      });

      // 6. Find or create Stage
      const stage = await tx.stage.upsert({
        where: {
          name_wardId_tenantId: {
            name: app.stageName,
            wardId: app.wardId,
            tenantId,
          },
        },
        create: {
          name: app.stageName,
          wardId: app.wardId,
          tenantId,
        },
        update: {},
        select: { id: true, name: true },
      });

      // 7. Create StageAssignment
      const assignment = await tx.stageAssignment.create({
        data: {
          userId: user.id,
          stageId: stage.id,
          position: (app.position as 'CHAIRMAN' | 'SECRETARY' | 'TREASURER' | 'MEMBER') ?? 'MEMBER',
          isActive: true,
        },
        select: { id: true, position: true },
      });

      // 8. Update application status
      await tx.memberApplication.update({
        where: { id: applicationId },
        data: {
          status: ApplicationStatus.APPROVED,
          reviewedBy: actorId,
          reviewNotes: dto.reviewNotes ?? 'Approved',
        },
      });

      return {
        user,
        member,
        accounts: [fosaAccount, bosaAccount],
        stage,
        assignment,
        tempPassword,
      };
    });
    // ── End transaction ───────────────────────────────────────────────────────

    // Audit log (outside transaction – non-fatal)
    await this.auditSafe({
      tenantId,
      userId: actorId,
      action: 'APPLICATION.APPROVE',
      resource: 'MemberApplication',
      resourceId: applicationId,
      metadata: {
        newUserId: result.user.id,
        memberNumber: result.member.memberNumber,
        accounts: result.accounts.map((a) => ({
          id: a.id,
          type: a.accountType,
          number: a.accountNumber,
        })),
        stageId: result.stage.id,
        stageName: result.stage.name,
        position: result.assignment.position,
      },
      ipAddress,
    });

    this.logger.log(
      `Application ${applicationId} approved → User ${result.user.id}, Member ${result.member.memberNumber}`,
    );

    return {
      success: true,
      user: result.user,
      member: result.member,
      accounts: result.accounts,
      stage: result.stage,
      stageAssignment: result.assignment,
      temporaryPassword: result.tempPassword,
      message: `Member ${result.member.memberNumber} created successfully. Temporary password issued — user must change on first login.`,
    };
  }

  // ─── REJECT ───────────────────────────────────────────────────────────────────

  async reject(
    applicationId: string,
    tenantId: string,
    actorId: string,
    dto: RejectApplicationDto,
    ipAddress?: string,
  ) {
    const app = await this.prisma.memberApplication.findFirst({
      where: { id: applicationId, tenantId },
      select: { id: true, status: true, firstName: true, lastName: true },
    });

    if (!app) throw new NotFoundException('Application not found');

    if (
      app.status !== ApplicationStatus.SUBMITTED &&
      app.status !== ApplicationStatus.PENDING_REVIEW
    ) {
      throw new BadRequestException(
        `Cannot reject application in status: ${app.status}`,
      );
    }

    const updated = await this.prisma.memberApplication.update({
      where: { id: applicationId },
      data: {
        status: ApplicationStatus.REJECTED,
        reviewedBy: actorId,
        reviewNotes: dto.reviewNotes,
      },
      select: {
        id: true,
        status: true,
        reviewNotes: true,
        firstName: true,
        lastName: true,
      },
    });

    await this.auditSafe({
      tenantId,
      userId: actorId,
      action: 'APPLICATION.REJECT',
      resource: 'MemberApplication',
      resourceId: applicationId,
      metadata: { reason: dto.reviewNotes },
      ipAddress,
    });

    this.logger.log(`Application ${applicationId} rejected by ${actorId}`);

    return {
      success: true,
      application: updated,
      message: `Application for ${app.firstName} ${app.lastName} has been rejected.`,
    };
  }

  // ─── PRIVATE HELPERS ──────────────────────────────────────────────────────────

  private generateTempPassword(): string {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$!';
    return Array.from({ length: 12 }, () =>
      chars[Math.floor(Math.random() * chars.length)],
    ).join('');
  }

  private async auditSafe(params: Parameters<AuditService['create']>[0]): Promise<void> {
    await this.audit
      .create(params)
      .catch((e: unknown) =>
        this.logger.error('Audit write failed (non-fatal)', e instanceof Error ? e.stack : e),
      );
  }
}
