import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { createHash, randomBytes } from 'crypto';
import * as Sentry from '@sentry/nestjs';
import { v4 as uuidv4 } from 'uuid';
import { AccountType, DocumentStatus, DocumentType, KycStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FeatureFlags } from '../../config/feature-flags';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { AlertsService } from '../alerts/alerts.service';
import {
  ConfirmDocumentUploadDto,
  DocumentUploadUrlResponseDto,
  MAX_DOCUMENT_UPLOAD_BYTES,
  RequestDocumentUploadUrlDto,
  ReviewDocumentDto,
} from './dto/document.dto';
import { DOCUMENT_ORPHAN_CLEANUP_JOB, QUEUE_NAMES } from '../queue/queue.constants';
import type { KycReviewJobPayload } from '../kyc/kyc-review.processor';
import { recordSaccoMetric, withSaccoSpan } from '../../common/sentry/sacco-tracing';

const LEGACY_UPLOAD_URL_TTL_SECONDS = 3600;
const SECURE_UPLOAD_URL_TTL_SECONDS = 900;

const REQUIRED_KYC_DOCUMENT_TYPES: DocumentType[] = [
  DocumentType.NATIONAL_ID_FRONT,
  DocumentType.NATIONAL_ID_BACK,
  DocumentType.KRA_PIN,
  DocumentType.MEMBER_FORM,
];

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'image/heic',
  'image/heif',
]);
// Some mobile browsers/file pickers don't report a real MIME type for HEIC/HEIF
// captures (or any file) and send "application/octet-stream" instead — mirrors
// the same fallback the frontend applies in app/member/profile/page.tsx.
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.pdf',
  '.heic',
  '.heif',
]);

const REVIEW_ROLES = new Set<UserRole>([
  UserRole.TENANT_ADMIN,
  UserRole.MANAGER,
  UserRole.CHAIRMAN,
  UserRole.LOAN_OFFICER,
]);
const VIEW_ROLES = new Set<UserRole>([
  UserRole.TENANT_ADMIN,
  UserRole.MANAGER,
  UserRole.CHAIRMAN,
  UserRole.LOAN_OFFICER,
  UserRole.AUDITOR,
]);

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly alerts: AlertsService,
    @InjectQueue(QUEUE_NAMES.DOCUMENT_CLEANUP)
    private readonly cleanupQueue: Queue,
    @InjectQueue(QUEUE_NAMES.KYC_REVIEW)
    private readonly kycReviewQueue: Queue<KycReviewJobPayload>,
  ) {}

  @Cron('*/15 * * * *')
  async enqueueOrphanCleanup(): Promise<void> {
    await this.cleanupQueue
      .add(
        DOCUMENT_ORPHAN_CLEANUP_JOB,
        { queuedAt: new Date().toISOString() },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
        },
      )
      .catch((err: unknown) =>
        this.logger.warn(
          `Document cleanup enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  async requestMemberUploadUrl(
    tenantId: string,
    userId: string,
    dto: RequestDocumentUploadUrlDto,
    ipAddress?: string,
  ): Promise<DocumentUploadUrlResponseDto> {
    this.assertUploadPayload(dto);
    const member = await this.resolveMemberForUser(tenantId, userId);

    const uploadTtlSeconds = this.uploadUrlTtlSeconds(tenantId);
    const version = await this.nextDocumentVersion(tenantId, member.id, dto.type);
    const objectKey = this.buildObjectKey(
      tenantId,
      member.id,
      dto.type,
      dto.mimeType,
      dto.originalFileName,
    );
    const expiresAt = new Date(Date.now() + uploadTtlSeconds * 1000);
    const declaredSizeBytes = this.getDeclaredSizeBytes(dto);
    const secureUpload = this.secureUploadTokenFields(tenantId, expiresAt);

    const document = await this.prisma.document.create({
      data: {
        tenantId,
        memberId: member.id,
        uploadedById: userId,
        objectKey,
        originalFileName: this.cleanFileName(
          dto.originalFileName ?? `${dto.type.toLowerCase()}.${this.extensionFor(dto.mimeType)}`,
        ),
        mimeType: dto.mimeType,
        sizeBytes: declaredSizeBytes,
        checksum: dto.checksum ?? null,
        type: dto.type,
        status: DocumentStatus.PENDING_UPLOAD,
        version,
        expiresAt,
        ...this.odpcComplianceFields(member),
        ...secureUpload.data,
      },
      select: { id: true, objectKey: true },
    });

    if (member.kycStatus === KycStatus.REJECTED) {
      await this.prisma.member.update({
        where: { id: member.id },
        data: {
          kycStatus: KycStatus.PENDING_UPLOAD,
          kycRejectionReason: null,
        },
      });
    }

    const signed = await this.withSentrySpan(
      'documents.generateUploadUrl',
      'storage.s3.presign',
      {
        tenantId,
        docType: dto.type,
        secureUploadV2: FeatureFlags.isEnabled('SECURE_UPLOAD_V2', tenantId),
      },
      () =>
        this.storage.getUploadUrlForKey({
          objectKey,
          contentType: dto.mimeType,
          expiresIn: uploadTtlSeconds,
        }),
    );
    await this.auditSafe({
      tenantId,
      userId,
      action: 'DOCUMENT.UPLOAD_INTENT',
      resource: 'Document',
      resourceId: document.id,
      metadata: {
        memberId: member.id,
        type: dto.type,
        objectKey,
        mimeType: dto.mimeType,
        declaredSizeBytes,
        expiresAt: expiresAt.toISOString(),
        secureUploadV2: FeatureFlags.isEnabled('SECURE_UPLOAD_V2', tenantId),
      },
      ipAddress,
    });

    this.incrementSentryMetric('document.upload_intent.created', {
      docType: dto.type,
      tenantId,
      secureUploadV2: FeatureFlags.isEnabled('SECURE_UPLOAD_V2', tenantId),
    });

    return {
      documentId: document.id,
      uploadUrl: signed.uploadUrl,
      preSignedUrl: signed.uploadUrl,
      objectKey: signed.objectKey,
      expiresIn: signed.expiresIn,
      maxBytes: MAX_DOCUMENT_UPLOAD_BYTES,
      ...(secureUpload.uploadToken && { uploadToken: secureUpload.uploadToken }),
    };
  }

  async confirmMemberUpload(
    tenantId: string,
    userId: string,
    dto: ConfirmDocumentUploadDto,
    ipAddress?: string,
  ) {
    const member = await this.resolveMemberForUser(tenantId, userId);
    if (FeatureFlags.isEnabled('SECURE_UPLOAD_V2', tenantId)) {
      return this.confirmSecureUpload({
        tenantId,
        memberId: member.id,
        actorId: userId,
        dto,
        actorScope: 'MEMBER',
        ipAddress,
      });
    }

    const document = await this.prisma.document.findFirst({
      where: {
        id: dto.documentId,
        tenantId,
        memberId: member.id,
        status: DocumentStatus.PENDING_UPLOAD,
      },
    });
    if (!document) throw new NotFoundException('Pending upload document not found');

    if (document.expiresAt && document.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Upload URL has expired. Request a new upload URL.');
    }

    this.assertObjectKeyOwnership(document.objectKey, tenantId, member.id);
    const metadata = await this.withSentrySpan(
      'documents.confirmUpload.headObject',
      'storage.s3.head',
      { tenantId, docType: document.type },
      () => this.storage.headFile(document.objectKey),
    ).catch((err: unknown) => {
      this.logger.warn(
        `HEAD failed for ${document.objectKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException('Uploaded object was not found in storage');
    });

    const storedMimeType = this.normalizeMimeType(metadata.contentType);
    if (storedMimeType !== document.mimeType) {
      throw new BadRequestException(
        `Uploaded MIME type mismatch. Expected ${document.mimeType}, got ${storedMimeType ?? 'unknown'}`,
      );
    }
    if (metadata.contentLength < 1) {
      throw new BadRequestException('Uploaded document is empty');
    }
    if (metadata.contentLength > MAX_DOCUMENT_UPLOAD_BYTES) {
      await this.storage.deleteFile(document.objectKey).catch(() => undefined);
      throw new BadRequestException(`Uploaded document exceeds ${MAX_DOCUMENT_UPLOAD_BYTES} bytes`);
    }

    // Verify stored size doesn't exceed declared size by more than 5%
    await this.storage.validateUploadedSize(document.objectKey, document.sizeBytes);

    const updated = await this.withSentrySpan(
      'documents.confirmUpload.persist',
      'db.prisma',
      { tenantId, docType: document.type },
      () =>
        this.prisma.document.update({
          where: { id: document.id },
          data: {
            status: DocumentStatus.PENDING_REVIEW,
            sizeBytes: metadata.contentLength,
            checksum: dto.checksum ?? document.checksum,
            expiresAt: null,
          },
          include: { member: { select: { id: true, kycStatus: true } } },
        }),
    );

    await this.syncMemberReviewReadiness(tenantId, member.id);

    await this.auditSafe({
      tenantId,
      userId,
      action: 'DOCUMENT.UPLOAD_CONFIRMED',
      resource: 'Document',
      resourceId: document.id,
      metadata: {
        memberId: member.id,
        type: document.type,
        objectKey: document.objectKey,
        sizeBytes: metadata.contentLength,
        eTag: metadata.eTag,
      },
      ipAddress,
    });

    this.incrementSentryMetric('document.upload_confirmed', {
      docType: document.type,
      tenantId,
      secureUploadV2: FeatureFlags.isEnabled('SECURE_UPLOAD_V2', tenantId),
      virusScanQueued: FeatureFlags.isEnabled('VIRUS_SCAN', tenantId),
    });
    recordSaccoMetric('sacco.document.confirmed', 1, {
      docType: document.type,
      tenantId,
      status: DocumentStatus.PENDING_REVIEW,
      actorScope: 'MEMBER',
      secureUploadV2: false,
    });

    return this.serializeDocument(updated);
  }

  async requestAdminUploadUrl(
    tenantId: string,
    actor: { id: string; role: UserRole },
    dto: import('./dto/document.dto').AdminRequestDocumentUploadUrlDto,
    ipAddress?: string,
  ): Promise<DocumentUploadUrlResponseDto> {
    this.assertCanView(actor.role); // Admins that can view can also upload on behalf of member
    this.assertUploadPayload(dto);

    const member = await this.prisma.member.findFirst({
      where: { id: dto.memberId, tenantId },
      select: { id: true, kycStatus: true, consentUpdatedAt: true },
    });
    if (!member) throw new NotFoundException('Member profile not found');

    const uploadTtlSeconds = this.uploadUrlTtlSeconds(tenantId);
    const version = await this.nextDocumentVersion(tenantId, member.id, dto.type);
    const objectKey = this.buildObjectKey(
      tenantId,
      member.id,
      dto.type,
      dto.mimeType,
      dto.originalFileName,
    );
    const expiresAt = new Date(Date.now() + uploadTtlSeconds * 1000);
    const declaredSizeBytes = this.getDeclaredSizeBytes(dto);
    const secureUpload = this.secureUploadTokenFields(tenantId, expiresAt);

    const document = await this.prisma.document.create({
      data: {
        tenantId,
        memberId: member.id,
        uploadedById: actor.id,
        objectKey,
        originalFileName: this.cleanFileName(
          dto.originalFileName ?? `${dto.type.toLowerCase()}.${this.extensionFor(dto.mimeType)}`,
        ),
        mimeType: dto.mimeType,
        sizeBytes: declaredSizeBytes,
        checksum: dto.checksum ?? null,
        type: dto.type,
        status: DocumentStatus.PENDING_UPLOAD,
        version,
        expiresAt,
        ...this.odpcComplianceFields(member),
        ...secureUpload.data,
      },
      select: { id: true, objectKey: true },
    });

    if (member.kycStatus === KycStatus.REJECTED) {
      await this.prisma.member.update({
        where: { id: member.id },
        data: {
          kycStatus: KycStatus.PENDING_UPLOAD,
          kycRejectionReason: null,
        },
      });
    }

    const signed = await this.withSentrySpan(
      'documents.generateAdminUploadUrl',
      'storage.s3.presign',
      {
        tenantId,
        docType: dto.type,
        actorRole: actor.role,
        secureUploadV2: FeatureFlags.isEnabled('SECURE_UPLOAD_V2', tenantId),
      },
      () =>
        this.storage.getUploadUrlForKey({
          objectKey,
          contentType: dto.mimeType,
          expiresIn: uploadTtlSeconds,
        }),
    );
    await this.auditSafe({
      tenantId,
      userId: actor.id,
      action: 'DOCUMENT.UPLOAD_INTENT',
      resource: 'Document',
      resourceId: document.id,
      metadata: {
        memberId: member.id,
        type: dto.type,
        objectKey,
        mimeType: dto.mimeType,
        declaredSizeBytes,
        expiresAt: expiresAt.toISOString(),
        actorScope: 'ADMIN',
        secureUploadV2: FeatureFlags.isEnabled('SECURE_UPLOAD_V2', tenantId),
      },
      ipAddress,
    });

    this.incrementSentryMetric('document.upload_intent.created', {
      docType: dto.type,
      tenantId,
      actorScope: 'ADMIN',
      secureUploadV2: FeatureFlags.isEnabled('SECURE_UPLOAD_V2', tenantId),
    });

    return {
      documentId: document.id,
      uploadUrl: signed.uploadUrl,
      preSignedUrl: signed.uploadUrl,
      objectKey: signed.objectKey,
      expiresIn: signed.expiresIn,
      maxBytes: MAX_DOCUMENT_UPLOAD_BYTES,
      ...(secureUpload.uploadToken && { uploadToken: secureUpload.uploadToken }),
    };
  }

  async confirmAdminUpload(
    tenantId: string,
    actor: { id: string; role: UserRole },
    dto: import('./dto/document.dto').AdminConfirmDocumentUploadDto,
    ipAddress?: string,
  ) {
    this.assertCanView(actor.role);
    const member = await this.prisma.member.findFirst({
      where: { id: dto.memberId, tenantId },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Member profile not found');

    if (FeatureFlags.isEnabled('SECURE_UPLOAD_V2', tenantId)) {
      return this.confirmSecureUpload({
        tenantId,
        memberId: member.id,
        actorId: actor.id,
        actorRole: actor.role,
        dto,
        actorScope: 'ADMIN',
        ipAddress,
      });
    }

    const document = await this.prisma.document.findFirst({
      where: {
        id: dto.documentId,
        tenantId,
        memberId: member.id,
        status: DocumentStatus.PENDING_UPLOAD,
      },
    });
    if (!document) throw new NotFoundException('Pending upload document not found');

    if (document.expiresAt && document.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Upload URL has expired. Request a new upload URL.');
    }

    this.assertObjectKeyOwnership(document.objectKey, tenantId, member.id);
    const metadata = await this.withSentrySpan(
      'documents.confirmAdminUpload.headObject',
      'storage.s3.head',
      { tenantId, docType: document.type, actorRole: actor.role },
      () => this.storage.headFile(document.objectKey),
    ).catch((err: unknown) => {
      this.logger.warn(
        `HEAD failed for ${document.objectKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException('Uploaded object was not found in storage');
    });

    const storedMimeType = this.normalizeMimeType(metadata.contentType);
    if (storedMimeType !== document.mimeType) {
      throw new BadRequestException(
        `Uploaded MIME type mismatch. Expected ${document.mimeType}, got ${storedMimeType ?? 'unknown'}`,
      );
    }
    if (metadata.contentLength < 1) {
      throw new BadRequestException('Uploaded document is empty');
    }
    if (metadata.contentLength > MAX_DOCUMENT_UPLOAD_BYTES) {
      await this.storage.deleteFile(document.objectKey).catch(() => undefined);
      throw new BadRequestException(`Uploaded document exceeds ${MAX_DOCUMENT_UPLOAD_BYTES} bytes`);
    }

    await this.storage.validateUploadedSize(document.objectKey, document.sizeBytes);

    const updated = await this.withSentrySpan(
      'documents.confirmAdminUpload.persist',
      'db.prisma',
      { tenantId, docType: document.type, actorRole: actor.role },
      () =>
        this.prisma.document.update({
          where: { id: document.id },
          data: {
            status: DocumentStatus.PENDING_REVIEW,
            sizeBytes: metadata.contentLength,
            checksum: dto.checksum ?? document.checksum,
            expiresAt: null,
          },
          include: { member: { select: { id: true, kycStatus: true } } },
        }),
    );

    await this.syncMemberReviewReadiness(tenantId, member.id);

    await this.auditSafe({
      tenantId,
      userId: actor.id,
      action: 'DOCUMENT.UPLOAD_CONFIRMED',
      resource: 'Document',
      resourceId: document.id,
      metadata: {
        memberId: member.id,
        type: document.type,
        objectKey: document.objectKey,
        sizeBytes: metadata.contentLength,
        eTag: metadata.eTag,
        actorScope: 'ADMIN',
      },
      ipAddress,
    });

    this.incrementSentryMetric('document.upload_confirmed', {
      docType: document.type,
      tenantId,
      actorScope: 'ADMIN',
      secureUploadV2: FeatureFlags.isEnabled('SECURE_UPLOAD_V2', tenantId),
      virusScanQueued: FeatureFlags.isEnabled('VIRUS_SCAN', tenantId),
    });
    recordSaccoMetric('sacco.document.confirmed', 1, {
      docType: document.type,
      tenantId,
      status: DocumentStatus.PENDING_REVIEW,
      actorScope: 'ADMIN',
      secureUploadV2: false,
    });

    return this.serializeDocument(updated);
  }

  async listMemberDocuments(tenantId: string, userId: string) {
    const member = await this.resolveMemberForUser(tenantId, userId);
    const documents = await this.prisma.document.findMany({
      where: { tenantId, memberId: member.id, status: { not: DocumentStatus.DELETED } },
      orderBy: [{ type: 'asc' }, { version: 'desc' }],
    });
    return documents.map((document) => this.serializeDocument(document));
  }

  async getMemberDownloadUrl(
    tenantId: string,
    userId: string,
    documentId: string,
    ipAddress?: string,
  ) {
    const member = await this.resolveMemberForUser(tenantId, userId);
    const document = await this.prisma.document.findFirst({
      where: {
        id: documentId,
        tenantId,
        memberId: member.id,
        status: { not: DocumentStatus.DELETED },
      },
    });
    if (!document) throw new NotFoundException('Document not found');

    const downloadUrl = await this.resolveDownloadUrl(document.objectKey, 300);
    await this.auditSafe({
      tenantId,
      userId,
      action: 'DOCUMENT.DOWNLOAD',
      resource: 'Document',
      resourceId: document.id,
      metadata: { memberId: member.id, actorScope: 'MEMBER', type: document.type },
      ipAddress,
    });
    return { downloadUrl, expiresIn: 300 };
  }

  async listAdminDocuments(
    tenantId: string,
    actor: { id: string; role: UserRole },
    opts: { status?: DocumentStatus; memberId?: string } = {},
  ) {
    this.assertCanView(actor.role);
    const documents = await this.prisma.document.findMany({
      where: {
        tenantId,
        ...(opts.status && { status: opts.status }),
        ...(opts.memberId && { memberId: opts.memberId }),
      },
      orderBy: { createdAt: 'asc' },
      include: {
        member: {
          select: {
            id: true,
            memberNumber: true,
            kycStatus: true,
            user: { select: { firstName: true, lastName: true, email: true, phone: true } },
          },
        },
      },
    });
    return documents.map((document) => ({
      ...this.serializeDocument(document),
      member: document.member,
    }));
  }

  async getAdminDownloadUrl(
    tenantId: string,
    actor: { id: string; role: UserRole },
    documentId: string,
    ipAddress?: string,
  ) {
    this.assertCanView(actor.role);
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId, status: { not: DocumentStatus.DELETED } },
    });
    if (!document) throw new NotFoundException('Document not found');

    const downloadUrl = await this.resolveDownloadUrl(document.objectKey, 300);
    await this.auditSafe({
      tenantId,
      userId: actor.id,
      action: 'DOCUMENT.DOWNLOAD',
      resource: 'Document',
      resourceId: document.id,
      metadata: {
        memberId: document.memberId,
        actorScope: 'ADMIN',
        actorRole: actor.role,
        type: document.type,
      },
      ipAddress,
    });
    return { downloadUrl, expiresIn: 300 };
  }

  async reviewDocument(
    tenantId: string,
    actor: { id: string; role: UserRole },
    documentId: string,
    dto: ReviewDocumentDto,
    ipAddress?: string,
  ) {
    this.assertCanReview(actor.role);
    if (dto.status !== DocumentStatus.APPROVED && dto.status !== DocumentStatus.REJECTED) {
      throw new BadRequestException('Document review status must be APPROVED or REJECTED');
    }
    if (dto.status === DocumentStatus.REJECTED && !dto.rejectionReason?.trim()) {
      throw new BadRequestException('Rejection reason is required');
    }

    const document = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId, status: DocumentStatus.PENDING_REVIEW },
      select: { id: true },
    });
    if (!document) throw new NotFoundException('Pending review document not found');

    const reviewedAt = new Date();
    const updated = await this.withSentrySpan(
      'kyc.reviewDocument.persist',
      'db.prisma',
      { tenantId, status: dto.status, actorRole: actor.role },
      () =>
        this.prisma.document.update({
          where: { id: document.id },
          data: {
            status: dto.status,
            reviewedById: actor.id,
            reviewedAt,
            rejectionReason:
              dto.status === DocumentStatus.REJECTED ? dto.rejectionReason?.trim() : null,
          },
          include: { member: { select: { id: true, kycStatus: true } } },
        }),
    );

    await this.syncMemberKycDecision(tenantId, updated.memberId, updated.type, dto, actor.id);

    await this.auditSafe({
      tenantId,
      userId: actor.id,
      action: 'DOCUMENT.REVIEWED',
      resource: 'Document',
      resourceId: updated.id,
      metadata: {
        memberId: updated.memberId,
        type: updated.type,
        status: dto.status,
        actorRole: actor.role,
        rejectionReason: dto.rejectionReason,
      },
      ipAddress,
    });

    this.incrementSentryMetric('document.reviewed', {
      docType: updated.type,
      tenantId,
      status: dto.status,
      actorRole: actor.role,
    });

    return this.serializeDocument(updated);
  }

  async enqueueKycReview(
    tenantId: string,
    actor: { id: string; role: UserRole },
    documentId: string,
    dto: ReviewDocumentDto,
  ): Promise<{ status: 'QUEUED'; jobId: string | undefined }> {
    this.assertCanReview(actor.role);
    if (dto.status !== DocumentStatus.APPROVED && dto.status !== DocumentStatus.REJECTED) {
      throw new BadRequestException('Review status must be APPROVED or REJECTED');
    }
    if (dto.status === DocumentStatus.REJECTED && !dto.rejectionReason?.trim()) {
      throw new BadRequestException('Rejection reason is required when rejecting');
    }

    const document = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId, status: DocumentStatus.PENDING_REVIEW },
      select: { id: true },
    });
    if (!document) throw new NotFoundException('Pending review document not found');

    const action: KycReviewJobPayload['action'] =
      dto.status === DocumentStatus.APPROVED ? 'APPROVED' : 'REJECTED';

    const job = await this.withSentrySpan(
      'kyc.enqueueReview',
      'queue.bullmq.add',
      { tenantId, action, actorRole: actor.role },
      () =>
        this.kycReviewQueue.add(
          'review',
          {
            docId: documentId,
            reviewerId: actor.id,
            action,
            tenantId,
            rejectionReason: dto.rejectionReason,
          },
          { attempts: 5, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 100 },
        ),
    );

    this.incrementSentryMetric('kyc.review.queued', {
      tenantId,
      action,
      actorRole: actor.role,
    });

    return { status: 'QUEUED', jobId: job.id };
  }

  async cleanupExpiredUploads(limit = 100): Promise<{ deleted: number }> {
    const expired = await this.prisma.document.findMany({
      where: {
        status: DocumentStatus.PENDING_UPLOAD,
        expiresAt: { lt: new Date() },
      },
      take: limit,
      orderBy: { expiresAt: 'asc' },
    });

    let deleted = 0;
    for (const document of expired) {
      await this.storage
        .deleteFile(document.objectKey)
        .catch((err: unknown) =>
          this.logger.warn(
            `Storage delete failed for expired document ${document.id}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      await this.prisma.document.update({
        where: { id: document.id },
        data: {
          status: DocumentStatus.DELETED,
          rejectionReason: 'Upload expired before confirmation',
        },
      });
      deleted++;
    }

    if (deleted > 0) {
      this.logger.log(`Cleaned up ${deleted} expired document upload intents`);
    }
    return { deleted };
  }

  private async confirmSecureUpload(args: {
    tenantId: string;
    memberId: string;
    actorId: string;
    actorRole?: UserRole;
    dto: ConfirmDocumentUploadDto;
    actorScope: 'MEMBER' | 'ADMIN';
    ipAddress?: string;
  }) {
    const { tenantId, memberId, actorId, actorRole, dto, actorScope, ipAddress } = args;

    if (!dto.uploadToken) {
      throw new BadRequestException('uploadToken is required when secure upload is enabled');
    }
    if (!dto.checksum) {
      throw new BadRequestException('checksum is required when secure upload is enabled');
    }

    const document = await this.prisma.document.findFirst({
      where: {
        id: dto.documentId,
        tenantId,
        memberId,
      },
    });
    if (!document) throw new NotFoundException('Pending upload document not found');
    if (document.status !== DocumentStatus.PENDING_UPLOAD) {
      this.logger.warn('Secure upload confirmation rejected: document is no longer pending upload');
      throw new ConflictException('INVALID_UPLOAD_TOKEN');
    }

    this.assertObjectKeyOwnership(document.objectKey, tenantId, memberId);
    const metadata = await this.withSentrySpan(
      'documents.confirmSecureUpload.headObject',
      'storage.s3.head',
      { tenantId, docType: document.type, actorScope },
      () => this.storage.headFile(document.objectKey),
    ).catch((err: unknown) => {
      this.logger.warn(
        `HEAD failed for ${document.objectKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException('Uploaded object was not found in storage');
    });

    const storedMimeType = this.normalizeMimeType(metadata.contentType);
    if (storedMimeType !== document.mimeType) {
      throw new BadRequestException(
        `Uploaded MIME type mismatch. Expected ${document.mimeType}, got ${storedMimeType ?? 'unknown'}`,
      );
    }
    if (metadata.contentLength < 1) {
      throw new BadRequestException('Uploaded document is empty');
    }
    if (metadata.contentLength > MAX_DOCUMENT_UPLOAD_BYTES) {
      await this.storage.deleteFile(document.objectKey).catch(() => undefined);
      throw new BadRequestException(`Uploaded document exceeds ${MAX_DOCUMENT_UPLOAD_BYTES} bytes`);
    }

    await this.storage.validateUploadedSize(document.objectKey, document.sizeBytes);

    // Verify integrity BEFORE marking the document confirmed. Checking after
    // the atomic update (as this used to) meant a failed/mismatched checksum
    // briefly left the row as PENDING_REVIEW — visible to the member and
    // counted as "uploaded" — before being corrected to QUARANTINE, and any
    // non-mismatch failure here (e.g. a storage read error) left it stuck at
    // PENDING_REVIEW with no correction at all.
    await this.verifyChecksumServerSide(
      { id: document.id, objectKey: document.objectKey, sizeBytes: metadata.contentLength },
      dto.checksum,
    );

    const confirmedAt = new Date();
    const updatedCount = await this.withSentrySpan(
      'documents.confirmSecureUpload.atomicUpdate',
      'db.prisma',
      { tenantId, docType: document.type, actorScope },
      () =>
        this.prisma.document.updateMany({
          where: {
            id: dto.documentId,
            tenantId,
            memberId,
            status: DocumentStatus.PENDING_UPLOAD,
            uploadToken: dto.uploadToken,
            uploadTokenExpires: { gt: confirmedAt },
            uploadConfirmed: false,
          },
          data: {
            status: DocumentStatus.PENDING_REVIEW,
            uploadConfirmed: true,
            uploadToken: null,
            uploadTokenExpires: null,
            checksum: dto.checksum,
            confirmedAt,
            expiresAt: null,
            sizeBytes: metadata.contentLength,
          },
        }),
    );

    if (updatedCount.count === 0) {
      this.logger.warn('Secure upload confirmation rejected: invalid, expired, or used token');
      throw new ConflictException('INVALID_UPLOAD_TOKEN');
    }

    const updated = await this.prisma.document.findUniqueOrThrow({
      where: { id: dto.documentId },
      include: { member: { select: { id: true, kycStatus: true } } },
    });

    await this.syncMemberReviewReadiness(tenantId, memberId);

    await this.auditSafe({
      tenantId,
      userId: actorId,
      action: 'DOCUMENT.CONFIRMED_SECURE',
      resource: 'Document',
      resourceId: document.id,
      metadata: {
        memberId,
        type: document.type,
        objectKey: document.objectKey,
        sizeBytes: metadata.contentLength,
        eTag: metadata.eTag,
        actorScope,
        actorRole,
        checksumVerified: true,
        tokenUsed: `${dto.uploadToken.slice(0, 8)}...`,
      },
      ipAddress,
    });

    this.incrementSentryMetric('document.upload_confirmed_secure', {
      docType: document.type,
      tenantId,
      actorScope,
      checksumVerified: true,
    });
    recordSaccoMetric('sacco.document.confirmed', 1, {
      docType: document.type,
      tenantId,
      status: DocumentStatus.PENDING_REVIEW,
      actorScope,
      secureUploadV2: true,
      checksumVerified: true,
    });

    return this.serializeDocument(updated);
  }

  private async verifyChecksumServerSide(
    document: { id: string; objectKey: string; sizeBytes: number },
    expectedChecksum: string,
  ): Promise<void> {
    await this.withSentrySpan(
      'documents.verifyChecksum',
      'file.integrity-check',
      { documentId: document.id },
      async () => {
        const stream = await this.storage.getFileStream(document.objectKey);
        const hash = createHash('sha256');
        let bytesProcessed = 0;
        const maxExpectedBytes = Math.ceil(document.sizeBytes * 1.1);

        for await (const chunk of stream) {
          hash.update(chunk);
          bytesProcessed += chunk.length;

          if (bytesProcessed > maxExpectedBytes || bytesProcessed > MAX_DOCUMENT_UPLOAD_BYTES) {
            throw new BadRequestException('FILE_SIZE_MISMATCH');
          }
        }

        const actualChecksum = hash.digest('hex');
        if (actualChecksum !== expectedChecksum.toLowerCase()) {
          await this.prisma.document.update({
            where: { id: document.id },
            data: {
              status: DocumentStatus.QUARANTINE,
              quarantineReason: 'CHECKSUM_MISMATCH',
              flaggedAt: new Date(),
            },
          });

          Sentry.captureMessage('Document checksum mismatch', {
            level: 'warning',
            extra: {
              documentId: document.id,
              expected: expectedChecksum,
              actual: actualChecksum,
              objectKey: document.objectKey,
            },
          });

          this.alerts
            .sendSlackAlert(
              `:warning: KYC document quarantined — checksum mismatch\n` +
                `Document: ${document.id}\n` +
                `Expected: \`${expectedChecksum}\`\n` +
                `Actual: \`${actualChecksum}\``,
            )
            .catch((err: unknown) =>
              this.logger.error(
                'Quarantine alert dispatch failed',
                err instanceof Error ? err.stack : err,
              ),
            );

          throw new BadRequestException('FILE_INTEGRITY_CHECK_FAILED');
        }
      },
    );
  }

  private async syncMemberReviewReadiness(tenantId: string, memberId: string): Promise<void> {
    const readyCount = await this.prisma.document.findMany({
      where: {
        tenantId,
        memberId,
        type: { in: REQUIRED_KYC_DOCUMENT_TYPES },
        status: { in: [DocumentStatus.PENDING_REVIEW, DocumentStatus.APPROVED] },
      },
      distinct: ['type'],
      select: { type: true },
    });

    if (readyCount.length === REQUIRED_KYC_DOCUMENT_TYPES.length) {
      await this.prisma.member.update({
        where: { id: memberId },
        data: {
          kycStatus: KycStatus.PENDING_REVIEW,
          kycRejectionReason: null,
        },
      });
    }
  }

  private uploadUrlTtlSeconds(tenantId: string): number {
    return FeatureFlags.isEnabled('SECURE_UPLOAD_V2', tenantId)
      ? SECURE_UPLOAD_URL_TTL_SECONDS
      : LEGACY_UPLOAD_URL_TTL_SECONDS;
  }

  private secureUploadTokenFields(
    tenantId: string,
    expiresAt: Date,
  ): {
    uploadToken?: string;
    data: { uploadToken?: string; uploadTokenExpires?: Date; uploadConfirmed?: boolean };
  } {
    if (!FeatureFlags.isEnabled('SECURE_UPLOAD_V2', tenantId)) return { data: {} };
    const uploadToken = randomBytes(32).toString('hex');
    return {
      uploadToken,
      data: {
        uploadToken,
        uploadTokenExpires: expiresAt,
        uploadConfirmed: false,
      },
    };
  }

  private odpcComplianceFields(member: { consentUpdatedAt?: Date | null }): {
    consentTimestamp: Date | null;
    retentionUntil: Date;
    dataClassification: string;
  } {
    const retentionUntil = new Date();
    retentionUntil.setFullYear(retentionUntil.getFullYear() + 7);

    return {
      consentTimestamp: member.consentUpdatedAt ?? null,
      retentionUntil,
      dataClassification: 'SENSITIVE',
    };
  }

  private incrementSentryMetric(name: string, tags: Record<string, unknown>): void {
    recordSaccoMetric(name, 1, tags);
  }

  private async withSentrySpan<T>(
    name: string,
    op: string,
    attributes: Record<string, string | number | boolean | undefined>,
    callback: () => Promise<T>,
  ): Promise<T> {
    return withSaccoSpan(
      {
        name,
        op,
        tenantId: typeof attributes.tenantId === 'string' ? attributes.tenantId : undefined,
        metadata: attributes,
      },
      callback,
    );
  }

  private captureSentryMessage(message: string, extra: Record<string, unknown>): void {
    Sentry.captureMessage(message, { level: 'warning', extra });
  }

  private async syncMemberKycDecision(
    tenantId: string,
    memberId: string,
    reviewedType: DocumentType,
    dto: ReviewDocumentDto,
    reviewedById: string,
  ): Promise<void> {
    if (
      dto.status === DocumentStatus.REJECTED &&
      REQUIRED_KYC_DOCUMENT_TYPES.includes(reviewedType)
    ) {
      await this.prisma.member.update({
        where: { id: memberId },
        data: {
          kycStatus: KycStatus.REJECTED,
          kycReviewedAt: new Date(),
          kycReviewedByUserId: reviewedById,
          kycRejectionReason: dto.rejectionReason?.trim(),
        },
      });
      return;
    }

    const approvedRequiredTypes = await this.prisma.document.findMany({
      where: {
        tenantId,
        memberId,
        type: { in: REQUIRED_KYC_DOCUMENT_TYPES },
        status: DocumentStatus.APPROVED,
      },
      distinct: ['type'],
      select: { type: true },
    });

    if (approvedRequiredTypes.length !== REQUIRED_KYC_DOCUMENT_TYPES.length) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.member.update({
        where: { id: memberId },
        data: {
          kycStatus: KycStatus.APPROVED,
          kycReviewedAt: new Date(),
          kycReviewedByUserId: reviewedById,
          kycRejectionReason: null,
        },
      });

      const existingAccounts = await tx.account.findMany({
        where: { tenantId, memberId, accountType: { in: [AccountType.FOSA, AccountType.BOSA] } },
        select: { accountType: true },
      });
      const existingTypes = new Set(existingAccounts.map((account) => account.accountType));
      const missingTypes = [AccountType.FOSA, AccountType.BOSA].filter(
        (type) => !existingTypes.has(type),
      );
      if (missingTypes.length === 0) return;

      const counter = await tx.tenantCounter.upsert({
        where: { tenantId },
        update: { accountSeq: { increment: missingTypes.length } },
        create: { tenantId, memberSeq: 0, accountSeq: missingTypes.length, loanSeq: 0 },
        select: { accountSeq: true },
      });
      const firstSeq = counter.accountSeq - missingTypes.length + 1;

      for (const [index, accountType] of missingTypes.entries()) {
        await tx.account.create({
          data: {
            tenantId,
            memberId,
            accountNumber: `ACC-${accountType}-${String(firstSeq + index).padStart(6, '0')}`,
            accountType,
          },
        });
      }
    });
  }

  private assertUploadPayload(dto: RequestDocumentUploadUrlDto): void {
    const mimeTypeIsTrustworthy = dto.mimeType !== 'application/octet-stream';
    const isAllowed = mimeTypeIsTrustworthy
      ? ALLOWED_MIME_TYPES.has(dto.mimeType)
      : this.hasAllowedExtension(dto.originalFileName);
    if (!isAllowed) {
      throw new BadRequestException(`Unsupported MIME type: ${dto.mimeType}`);
    }
    const declaredSizeBytes = this.getDeclaredSizeBytes(dto);
    if (declaredSizeBytes > MAX_DOCUMENT_UPLOAD_BYTES) {
      throw new BadRequestException(`Document exceeds ${MAX_DOCUMENT_UPLOAD_BYTES} bytes`);
    }
  }

  private hasAllowedExtension(fileName?: string): boolean {
    return this.extensionFromFileName(fileName) !== null;
  }

  /** Returns the lowercased extension (no leading dot) if it's in the allowed set, else null. */
  private extensionFromFileName(fileName?: string): string | null {
    if (!fileName) return null;
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex === -1) return null;
    const extensionWithDot = fileName.slice(dotIndex).toLowerCase();
    return ALLOWED_UPLOAD_EXTENSIONS.has(extensionWithDot) ? extensionWithDot.slice(1) : null;
  }

  private getDeclaredSizeBytes(dto: RequestDocumentUploadUrlDto): number {
    const declaredSizeBytes = dto.sizeBytes ?? dto.fileSize;
    if (!declaredSizeBytes) {
      throw new BadRequestException('sizeBytes is required');
    }
    return declaredSizeBytes;
  }

  private assertCanView(role: UserRole): void {
    if (!VIEW_ROLES.has(role) && role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('You do not have permission to view KYC documents');
    }
  }

  private assertCanReview(role: UserRole): void {
    if (!REVIEW_ROLES.has(role) && role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only TENANT_ADMIN, MANAGER, CHAIRMAN, and LOAN_OFFICER can review KYC documents',
      );
    }
  }

  /** True for a documentUrl-seeded record (see onboarding.service.ts) whose objectKey
   * is still a raw external URL rather than a key inside the managed R2/MinIO bucket.
   *
   * DocumentIngestionProcessor (Phase 3) normally re-hosts these within seconds of
   * approval and swaps objectKey for a real key, so this should be rare/transient in
   * practice. Deliberately kept (not removed) as a fallback for the window before
   * ingestion completes, and for any record where ingestion permanently failed
   * (Sentry-alerted — see DocumentIngestionProcessor#onFailed) or pre-dates the
   * ingestion pipeline. Removing it would leave those documents with no working
   * download path at all. */
  private isExternalUrl(objectKey: string): boolean {
    return /^https?:\/\//i.test(objectKey);
  }

  /** Resolves a document's download URL, bypassing the storage service's pre-signing
   * for externally-hosted documents (their objectKey already *is* the URL). */
  private async resolveDownloadUrl(objectKey: string, expiresIn: number): Promise<string> {
    if (this.isExternalUrl(objectKey)) {
      return objectKey;
    }
    return this.storage.getDownloadUrl(objectKey, expiresIn);
  }

  private async resolveMemberForUser(tenantId: string, userId: string) {
    const member = await this.prisma.member.findFirst({
      where: { tenantId, userId },
      select: { id: true, kycStatus: true, consentUpdatedAt: true },
    });
    if (!member) throw new NotFoundException('Member profile not found');
    return member;
  }

  private async nextDocumentVersion(
    tenantId: string,
    memberId: string,
    type: DocumentType,
  ): Promise<number> {
    const latest = await this.prisma.document.findFirst({
      where: { tenantId, memberId, type },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return (latest?.version ?? 0) + 1;
  }

  private buildObjectKey(
    tenantId: string,
    memberId: string,
    type: DocumentType,
    mimeType: string,
    originalFileName?: string,
  ): string {
    return `tenants/${tenantId}/members/${memberId}/${type.toLowerCase()}_${Date.now()}_${uuidv4()}.${this.extensionFor(mimeType, originalFileName)}`;
  }

  private assertObjectKeyOwnership(objectKey: string, tenantId: string, memberId: string): void {
    const expectedPrefix = `tenants/${tenantId}/members/${memberId}/`;
    if (!objectKey.startsWith(expectedPrefix)) {
      throw new BadRequestException('Document object key does not match member tenant scope');
    }
  }

  private extensionFor(mimeType: string, originalFileName?: string): string {
    switch (mimeType) {
      case 'image/jpeg':
        return 'jpg';
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      case 'application/pdf':
        return 'pdf';
      case 'image/heic':
        return 'heic';
      case 'image/heif':
        return 'heif';
      default: {
        // Unrecognized/octet-stream MIME types reach here only after
        // assertUploadPayload() already validated the file extension itself.
        const fromFileName = this.extensionFromFileName(originalFileName);
        if (fromFileName) return fromFileName;
        throw new BadRequestException(`Unsupported MIME type: ${mimeType}`);
      }
    }
  }

  private cleanFileName(fileName: string): string {
    return fileName.replace(/[\\/]/g, '_').trim().slice(0, 255);
  }

  private normalizeMimeType(mimeType: string | null): string | null {
    return mimeType?.split(';')[0]?.trim().toLowerCase() ?? null;
  }

  private serializeDocument(document: {
    id: string;
    tenantId: string;
    memberId: string;
    uploadedById: string;
    objectKey: string;
    originalFileName: string;
    mimeType: string;
    sizeBytes: number;
    checksum: string | null;
    type: DocumentType;
    status: DocumentStatus;
    version: number;
    reviewedById: string | null;
    reviewedAt: Date | null;
    rejectionReason: string | null;
    expiresAt: Date | null;
    consentTimestamp?: Date | null;
    retentionUntil?: Date | null;
    dataClassification?: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: document.id,
      memberId: document.memberId,
      type: document.type,
      status: document.status,
      originalFileName: document.originalFileName,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      checksum: document.checksum,
      version: document.version,
      reviewedById: document.reviewedById,
      reviewedAt: document.reviewedAt,
      rejectionReason: document.rejectionReason,
      expiresAt: document.expiresAt,
      consentTimestamp: document.consentTimestamp ?? null,
      retentionUntil: document.retentionUntil ?? null,
      dataClassification: document.dataClassification ?? 'PERSONAL',
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }

  private async auditSafe(args: {
    tenantId: string;
    userId: string;
    action: string;
    resource: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
  }): Promise<void> {
    await this.audit
      .create(args)
      .catch((err: unknown) =>
        this.logger.error('Document audit write failed', err instanceof Error ? err.stack : err),
      );
  }
}
