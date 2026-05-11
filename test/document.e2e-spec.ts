import { JwtService } from '@nestjs/jwt';
import {
  DocumentStatus,
  DocumentType,
  KycStatus,
  UserRole,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import * as argon2 from 'argon2';
import { TestAppContext, TestAppFactory } from './helpers/test-app.factory';
import { StorageService } from '../src/modules/storage/storage.service';
import { DocumentsService } from '../src/modules/documents/documents.service';

describe('Document Workflow E2E', () => {
  let ctx: TestAppContext;
  let jwt: JwtService;
  let storage: StorageService;
  let documents: DocumentsService;
  let loanOfficerToken: string;

  beforeAll(async () => {
    ctx = await TestAppFactory.create();
    jwt = ctx.app.get(JwtService);
    storage = ctx.app.get(StorageService);
    documents = ctx.app.get(DocumentsService);

    jest.spyOn(storage, 'getUploadUrlForKey').mockImplementation(async ({ objectKey }) => ({
      uploadUrl: `https://storage.test/${encodeURIComponent(objectKey)}`,
      objectKey,
      expiresIn: 3600,
    }));
    jest.spyOn(storage, 'headFile').mockResolvedValue({
      contentLength: 1024,
      contentType: 'image/jpeg',
      eTag: '"test-etag"',
      lastModified: new Date(),
    });
    jest.spyOn(storage, 'deleteFile').mockResolvedValue(undefined);

    const loanOfficerId = uuidv4();
    await ctx.prisma.user.create({
      data: {
        id: loanOfficerId,
        tenantId: ctx.seed.tenantId,
        email: 'loan-officer@test-sacco.co.ke',
        passwordHash: await argon2.hash('TestPassword123!'),
        role: UserRole.LOAN_OFFICER,
        firstName: 'Loan',
        lastName: 'Officer',
        phone: '254744444444',
        isActive: true,
        emailVerified: true,
        status: 'APPROVED',
      },
    });

    loanOfficerToken = jwt.sign({
      sub: loanOfficerId,
      email: 'loan-officer@test-sacco.co.ke',
      role: UserRole.LOAN_OFFICER,
      tenantId: ctx.seed.tenantId,
      jti: uuidv4(),
    });
  }, 60000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await ctx.teardown();
  }, 30000);

  it('blocks cross-tenant document queue access', async () => {
    const otherTenantId = uuidv4();
    await ctx
      .request()
      .get('/api/admin/kyc/documents')
      .set('Authorization', `Bearer ${ctx.seed.adminToken}`)
      .set('X-Tenant-ID', otherTenantId)
      .expect(403);
  });

  it('generates an upload URL, confirms upload, and transitions to PENDING_REVIEW', async () => {
    const urlRes = await ctx
      .request()
      .post('/api/members/documents/upload-url')
      .set('Authorization', `Bearer ${ctx.seed.memberToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .send({
        type: DocumentType.NATIONAL_ID_FRONT,
        mimeType: 'image/jpeg',
        fileSize: 1024,
      })
      .expect(201);

    expect(urlRes.body.documentId).toBeDefined();
    expect(urlRes.body.preSignedUrl).toBeDefined();

    await ctx
      .request()
      .post(`/api/members/documents/${urlRes.body.documentId}/confirm`)
      .set('Authorization', `Bearer ${ctx.seed.memberToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .send({})
      .expect(200);

    const document = await ctx.prisma.document.findFirst({
      where: { id: urlRes.body.documentId, tenantId: ctx.seed.tenantId },
    });
    expect(document?.status).toBe(DocumentStatus.PENDING_REVIEW);
  });

  it('blocks LOAN_OFFICER from approving KYC documents', async () => {
    const pendingDoc = await ctx.prisma.document.findFirst({
      where: { tenantId: ctx.seed.tenantId, status: DocumentStatus.PENDING_REVIEW },
    });
    expect(pendingDoc).toBeTruthy();

    await ctx
      .request()
      .patch(`/api/admin/kyc/documents/${pendingDoc!.id}/review`)
      .set('Authorization', `Bearer ${loanOfficerToken}`)
      .set('X-Tenant-ID', ctx.seed.tenantId)
      .send({ status: DocumentStatus.APPROVED })
      .expect(403);
  });

  it('allows MANAGER to approve all mandatory docs and updates Member.kycStatus', async () => {
    await ctx.prisma.member.update({
      where: { id: ctx.seed.memberId },
      data: { kycStatus: KycStatus.PENDING_REVIEW },
    });

    const mandatoryTypes = [
      DocumentType.NATIONAL_ID_FRONT,
      DocumentType.NATIONAL_ID_BACK,
      DocumentType.KRA_PIN,
      DocumentType.MEMBER_FORM,
    ];

    await ctx.prisma.document.createMany({
      data: mandatoryTypes.map((type) => ({
        tenantId: ctx.seed.tenantId,
        memberId: ctx.seed.memberId,
        uploadedById: ctx.seed.memberUserId,
        objectKey: `tenants/${ctx.seed.tenantId}/members/${ctx.seed.memberId}/${type.toLowerCase()}-${uuidv4()}.jpg`,
        originalFileName: `${type.toLowerCase()}.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        type,
        status: DocumentStatus.PENDING_REVIEW,
        expiresAt: null,
      })),
    });

    const docs = await ctx.prisma.document.findMany({
      where: {
        tenantId: ctx.seed.tenantId,
        memberId: ctx.seed.memberId,
        type: { in: mandatoryTypes },
        status: DocumentStatus.PENDING_REVIEW,
      },
      select: { id: true },
    });

    for (const doc of docs) {
      await ctx
        .request()
        .patch(`/api/admin/kyc/documents/${doc.id}/review`)
        .set('Authorization', `Bearer ${ctx.seed.adminToken}`)
        .set('X-Tenant-ID', ctx.seed.tenantId)
        .send({ status: DocumentStatus.APPROVED })
        .expect(200);
    }

    const member = await ctx.prisma.member.findUnique({ where: { id: ctx.seed.memberId } });
    expect(member?.kycStatus).toBe(KycStatus.APPROVED);
  });

  it('cleans expired pending upload metadata and storage objects', async () => {
    const expired = await ctx.prisma.document.create({
      data: {
        tenantId: ctx.seed.tenantId,
        memberId: ctx.seed.memberId,
        uploadedById: ctx.seed.memberUserId,
        objectKey: `tenants/${ctx.seed.tenantId}/members/${ctx.seed.memberId}/expired-${uuidv4()}.jpg`,
        originalFileName: 'expired.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        type: DocumentType.OTHER,
        status: DocumentStatus.PENDING_UPLOAD,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    await expect(documents.cleanupExpiredUploads()).resolves.toEqual({ deleted: expect.any(Number) });

    const reloaded = await ctx.prisma.document.findUnique({ where: { id: expired.id } });
    expect(reloaded?.status).toBe(DocumentStatus.DELETED);
    expect(storage.deleteFile).toHaveBeenCalledWith(expired.objectKey);
  });
});
