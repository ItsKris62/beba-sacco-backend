import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  ApplicationStatus,
  AccountType,
  KycStatus,
  UserRole,
  AccountStatus,
  DocumentType,
  DocumentStatus,
} from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SmsService } from '../sms/sms.service';
import { QUEUE_NAMES, DocumentIngestionJobPayload } from '../queue/queue.constants';
import { ApproveApplicationDto, RejectApplicationDto } from './dto/review-application.dto';

/**
 * OnboardingService
 *
 * Handles the transactional approval of member applications.
 *
 * Approval flow (atomic $transaction):
 *  1. Validate application is in SUBMITTED or PENDING_REVIEW state
 *  2. Check for duplicate idNumber / phoneNumber on User table
 *  3. Generate role-prefixed random member number (retried on collision)
 *  4. Create User (mustChangePassword = true)
 *  5. Create Member profile (kycStatus = PENDING_UPLOAD)
 *  6. Create FOSA account
 *  7. Create BOSA account
 *  8. Find existing Stage by name+ward, then create StageAssignment
 *  9. Update MemberApplication.status = APPROVED
 * 10. Audit log
 *
 * Member number format: {ROLE_PREFIX}-{6-digit-random}
 *   MEMBER    → MBR-XXXXXX
 *   CHAIRMAN  → CHM-XXXXXX
 *   SECRETARY → SEC-XXXXXX
 *   TREASURER → TRS-XXXXXX
 *
 * IMPORTANT – Neon DB: Interactive transactions ($transaction callback form) require
 * a direct (non-pooler) connection. Set DIRECT_URL in your environment to the
 * non-pooler Neon connection string.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly smsService: SmsService,
    @InjectQueue(QUEUE_NAMES.DOCUMENT_INGESTION)
    private readonly documentIngestionQueue: Queue<DocumentIngestionJobPayload>,
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

    // Idempotency: if already APPROVED, return the existing member data
    if (app.status === ApplicationStatus.APPROVED) {
      const existingMember = await this.prisma.member.findFirst({
        where: { tenantId, nationalId: app.idNumber },
        include: {
          user: { select: { id: true, email: true, firstName: true, lastName: true } },
          accounts: { select: { id: true, accountNumber: true, accountType: true } },
        },
      });
      if (existingMember) {
        return {
          success: true,
          user: existingMember.user,
          member: { id: existingMember.id, memberNumber: existingMember.memberNumber },
          accounts: existingMember.accounts,
          stage: { id: '', name: app.stageName },
          stageAssignment: { id: '', position: app.position },
          temporaryPassword: '(already set — member must use existing password)',
          message: `Member ${existingMember.memberNumber} was already created from this application.`,
        };
      }
    }

    if (
      app.status !== ApplicationStatus.SUBMITTED &&
      app.status !== ApplicationStatus.PENDING_REVIEW
    ) {
      throw new BadRequestException(
        `Cannot approve application in status: ${app.status}. Only SUBMITTED or PENDING_REVIEW applications can be approved.`,
      );
    }

    // Extra idempotency: a previous attempt may have committed the member row but
    // failed before updating the application status.
    const preExistingMember = await this.prisma.member.findFirst({
      where: { tenantId, nationalId: app.idNumber },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
        accounts: { select: { id: true, accountNumber: true, accountType: true } },
      },
    });
    if (preExistingMember) {
      await this.prisma.memberApplication
        .update({
          where: { id: applicationId },
          data: { status: ApplicationStatus.APPROVED, reviewedBy: actorId },
        })
        .catch(() => {});
      return {
        success: true,
        user: preExistingMember.user,
        member: { id: preExistingMember.id, memberNumber: preExistingMember.memberNumber },
        accounts: preExistingMember.accounts,
        stage: { id: '', name: app.stageName },
        stageAssignment: { id: '', position: app.position },
        temporaryPassword: '(already set — member must use existing password)',
        message: `Member ${preExistingMember.memberNumber} was already created from this application.`,
      };
    }

    // Duplicate guard on User table
    const dupUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ idNumber: app.idNumber }, { phoneNumber: app.phoneNumber }],
      },
      select: { id: true, idNumber: true, phoneNumber: true },
    });
    if (dupUser) {
      const field = dupUser.idNumber === app.idNumber ? 'ID number' : 'phone number';
      throw new ConflictException(`A user with this ${field} already exists.`);
    }

    // Derive email
    const email =
      dto.email?.toLowerCase() ?? `member.${app.idNumber}@${tenantId.slice(0, 8)}.beba.local`;

    const dupEmail = await this.prisma.user.findFirst({
      where: { email },
      select: { id: true },
    });
    if (dupEmail) {
      throw new ConflictException(
        `Email ${email} is already registered. Provide a different email in the approval request.`,
      );
    }

    const tempPassword = dto.temporaryPassword ?? this.generateTempPassword();
    const passwordHash = await argon2.hash(tempPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    // ── Atomic transaction with retry on number collision ─────────────────────
    const MAX_ATTEMPTS = 3;
    let result:
      | {
          user: { id: string; email: string; firstName: string; lastName: string };
          member: { id: string; memberNumber: string };
          accounts: { id: string; accountNumber: string; accountType: string }[];
          stage: { id: string; name: string };
          assignment: { id: string; position: string };
          tempPassword: string;
          seededDocument: { id: string; type: DocumentType } | null;
        }
      | undefined;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const memberNumber = this.generateMemberNumber(app.position);
      const fosaAccNum = this.generateAccountNumber('FOSA');
      const bosaAccNum = this.generateAccountNumber('BOSA');

      try {
        result = await this.prisma.$transaction(async (tx) => {
          // 1. Create User
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
              accountStatus: AccountStatus.ACTIVE,
            },
            select: { id: true, email: true, firstName: true, lastName: true },
          });

          // 2. Create Member profile
          const member = await tx.member.create({
            data: {
              tenantId,
              userId: user.id,
              memberNumber,
              nationalId: app.idNumber,
              kycStatus: KycStatus.PENDING_UPLOAD,
              isActive: true,
              memberApplicationId: app.id,
            },
            select: { id: true, memberNumber: true },
          });

          // 2b. Seed a KYC document from the application's collected form URL (if any)
          // so it surfaces in the KYC Queue instead of being discarded on approval.
          // This alone does not complete KYC — the member still needs the remaining
          // REQUIRED_KYC_DOCUMENT_TYPES (admin.service.ts) uploaded and reviewed.
          //
          // objectKey is seeded with the raw external URL for now — DocumentIngestionProcessor
          // (enqueued below, outside this transaction) fetches it and swaps objectKey for a
          // real key in the managed bucket. If ingestion fails, DocumentsService#resolveDownloadUrl's
          // isExternalUrl fallback keeps the document downloadable via the original URL.
          const seededDocument = app.documentUrl
            ? await tx.document.create({
                data: {
                  tenantId,
                  memberId: member.id,
                  uploadedById: actorId,
                  objectKey: app.documentUrl,
                  originalFileName: this.fileNameFromUrl(app.documentUrl),
                  mimeType: this.mimeTypeFromUrl(app.documentUrl),
                  sizeBytes: 0,
                  type: DocumentType.MEMBER_FORM,
                  status: DocumentStatus.PENDING_REVIEW,
                },
                select: { id: true, type: true },
              })
            : null;

          // 3. Create FOSA account
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

          // 4. Create BOSA account
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

          // 5. Find or create Stage (upsert so the approval is self-healing)
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

          // 6. Create StageAssignment
          const assignment = await tx.stageAssignment.create({
            data: {
              userId: user.id,
              stageId: stage.id,
              // app.position is StagePosition (non-nullable) since the enum migration —
              // no cast/fallback needed anymore.
              position: app.position,
              isActive: true,
            },
            select: { id: true, position: true },
          });

          // 7. Update application status
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
            seededDocument,
          };
        });

        break; // transaction succeeded — exit retry loop
      } catch (err) {
        if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
          const fields = Array.isArray(err.meta?.target)
            ? (err.meta.target as string[]).join(', ')
            : String(err.meta?.target ?? '');

          // Number collision — retry with freshly generated numbers
          if (
            attempt < MAX_ATTEMPTS - 1 &&
            (fields.includes('memberNumber') || fields.includes('accountNumber'))
          ) {
            this.logger.warn(
              `Number collision on attempt ${attempt + 1} for application ${applicationId} (fields: ${fields}), retrying…`,
            );
            continue;
          }

          // Phone or ID already exists on User table
          if (fields.includes('phoneNumber')) {
            throw new ConflictException('A user with this phone number already exists.');
          }
          if (fields.includes('idNumber')) {
            throw new ConflictException('A user with this ID number already exists.');
          }
          if (fields.includes('email')) {
            throw new ConflictException(
              `Email ${email} is already registered. Provide a different email.`,
            );
          }

          this.logger.error(
            `Prisma P2002 on fields "${fields}" for application ${applicationId}`,
            err.message,
          );
          throw new ConflictException(
            `A member with this ${fields || 'ID number or phone number'} already exists.`,
          );
        }

        if (err instanceof PrismaClientKnownRequestError) {
          this.logger.error(
            `Prisma error ${err.code} during member approval for application ${applicationId}`,
            err.message,
          );
          throw new InternalServerErrorException(
            'Member creation failed. If this persists, ensure DIRECT_URL is set to the non-pooler Neon connection string.',
          );
        }

        throw err;
      }
    }

    if (!result) {
      this.logger.error(
        `Failed to generate unique numbers after ${MAX_ATTEMPTS} attempts for application ${applicationId}`,
      );
      throw new InternalServerErrorException(
        'Could not generate unique member number after multiple attempts. Please try again.',
      );
    }
    // ── End transaction ───────────────────────────────────────────────────────

    // Best-effort SMS notification — enqueue never throws (SmsService catches
    // internally), so this can't fail the request. `smsEnqueued` reflects whether
    // the job was queued, not final delivery. If it fails to queue, the admin
    // still gets the plaintext password below so the member isn't locked out.
    const smsEnqueued = await this.smsService.enqueueSms(
      {
        type: 'TEMP_PASSWORD',
        phone: app.phoneNumber,
        message: `Your Beba SACCO temporary password is ${result.tempPassword}. You must verify your phone and change it on first login.`,
      },
      `applications.approve:${result.user.id}`,
    );

    // Best-effort ingestion of the seeded document's external URL into the managed
    // bucket (outside the transaction — a slow/failing fetch must not hold up member
    // creation or the response). Never throws: DocumentIngestionProcessor leaves the
    // Document row untouched on failure, and resolveDownloadUrl's external-URL
    // fallback keeps it downloadable in the meantime.
    if (result.seededDocument) {
      await this.documentIngestionQueue
        .add('ingest', {
          tenantId,
          documentId: result.seededDocument.id,
          memberId: result.member.id,
          documentType: result.seededDocument.type,
          sourceUrl: app.documentUrl!,
        } satisfies DocumentIngestionJobPayload)
        .catch((e: unknown) =>
          this.logger.error(
            'Document ingestion enqueue failed (non-fatal)',
            e instanceof Error ? e.stack : e,
          ),
        );
    }

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
        smsEnqueued,
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
      smsEnqueued,
      message: smsEnqueued
        ? `Member ${result.member.memberNumber} created successfully. Temporary password sent via SMS.`
        : `Member ${result.member.memberNumber} created successfully, but SMS enqueue failed. Share the temporary password with the member manually.`,
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
      throw new BadRequestException(`Cannot reject application in status: ${app.status}`);
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

  /**
   * Generates a role-prefixed random member number.
   * Format: {PREFIX}-{6-digit-random}
   *   MEMBER    → MBR-XXXXXX
   *   CHAIRMAN  → CHM-XXXXXX
   *   SECRETARY → SEC-XXXXXX
   *   TREASURER → TRS-XXXXXX
   */
  private generateMemberNumber(position: string): string {
    const prefixes: Record<string, string> = {
      CHAIRMAN: 'CHM',
      SECRETARY: 'SEC',
      TREASURER: 'TRS',
      MEMBER: 'MBR',
    };
    const prefix = prefixes[position?.toUpperCase()] ?? 'MBR';
    const num = Math.floor(100000 + Math.random() * 900000);
    return `${prefix}-${num}`;
  }

  /** Generates a random account number. Format: {TYPE}-XXXXXX */
  private generateAccountNumber(type: 'FOSA' | 'BOSA'): string {
    const num = Math.floor(100000 + Math.random() * 900000);
    return `${type}-${num}`;
  }

  /** Best-effort original filename derived from a documentUrl's path segment. */
  private fileNameFromUrl(url: string): string {
    try {
      const segment = new URL(url).pathname.split('/').pop();
      return segment ? decodeURIComponent(segment) : 'application-form';
    } catch {
      return 'application-form';
    }
  }

  /** Best-effort MIME type derived from a documentUrl's file extension. */
  private mimeTypeFromUrl(url: string): string {
    const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
    const byExtension: Record<string, string> = {
      pdf: 'application/pdf',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      heic: 'image/heic',
      heif: 'image/heif',
    };
    return (ext && byExtension[ext]) || 'application/octet-stream';
  }

  private generateTempPassword(): string {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$!';
    return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join(
      '',
    );
  }

  private async auditSafe(params: Parameters<AuditService['create']>[0]): Promise<void> {
    await this.audit
      .create(params)
      .catch((e: unknown) =>
        this.logger.error('Audit write failed (non-fatal)', e instanceof Error ? e.stack : e),
      );
  }
}
