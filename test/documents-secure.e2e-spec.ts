import { BadRequestException, ConflictException } from '@nestjs/common';
import { DocumentStatus, DocumentType, KycStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { DocumentsService } from '../src/modules/documents/documents.service';

const tenantId = '11111111-1111-1111-1111-111111111111';
const userId = '22222222-2222-2222-2222-222222222222';
const memberId = '33333333-3333-3333-3333-333333333333';
const documentId = '44444444-4444-4444-4444-444444444444';
const uploadToken = 'b'.repeat(64);
const uploadedBytes = Buffer.from('verified content');
const uploadedChecksum = createHash('sha256').update(uploadedBytes).digest('hex');

describe('Secure Upload Flow (FEATURE_SECURE_UPLOAD_V2=true)', () => {
  const originalFlag = process.env.FEATURE_SECURE_UPLOAD_V2;

  beforeEach(() => {
    process.env.FEATURE_SECURE_UPLOAD_V2 = 'true';
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.FEATURE_SECURE_UPLOAD_V2;
    else process.env.FEATURE_SECURE_UPLOAD_V2 = originalFlag;
    jest.clearAllMocks();
  });

  it('generates upload URLs with 900s TTL and a single-use token', async () => {
    const { service, prisma } = createDocumentsServiceHarness();

    const response = await service.requestMemberUploadUrl(tenantId, userId, {
      type: DocumentType.NATIONAL_ID_FRONT,
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      originalFileName: 'test.jpg',
      checksum: uploadedChecksum,
    });

    expect(response).toMatchObject({
      documentId,
      expiresIn: 900,
      uploadToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(prisma.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          uploadToken: response.uploadToken,
          uploadTokenExpires: expect.any(Date),
          uploadConfirmed: false,
        }),
      }),
    );
  });

  it('rejects replay attempts with the same upload token', async () => {
    const { service, prisma, documentRecord } = createDocumentsServiceHarness();

    const first = await service.confirmMemberUpload(tenantId, userId, {
      documentId,
      checksum: uploadedChecksum,
      uploadToken,
    });

    expect(first).toMatchObject({ id: documentId, status: DocumentStatus.PENDING_REVIEW });
    expect(prisma.document.updateMany).toHaveBeenCalledTimes(1);

    prisma.document.findFirst.mockResolvedValueOnce({
      ...documentRecord,
      status: DocumentStatus.PENDING_REVIEW,
      uploadConfirmed: true,
    });

    await expect(
      service.confirmMemberUpload(tenantId, userId, {
        documentId,
        checksum: uploadedChecksum,
        uploadToken,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects expired upload tokens', async () => {
    const { service, prisma } = createDocumentsServiceHarness();
    prisma.document.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.confirmMemberUpload(tenantId, userId, {
        documentId,
        checksum: uploadedChecksum,
        uploadToken,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ message: 'INVALID_UPLOAD_TOKEN' }),
    });
  });

  it('quarantines documents when server-side checksum verification fails', async () => {
    const { service, prisma, storage, alerts } = createDocumentsServiceHarness();
    storage.getFileStream.mockResolvedValueOnce(
      (async function* () {
        yield Buffer.from('tampered content');
      })(),
    );

    await expect(
      service.confirmMemberUpload(tenantId, userId, {
        documentId,
        checksum: uploadedChecksum,
        uploadToken,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: documentId },
        data: expect.objectContaining({
          status: DocumentStatus.QUARANTINE,
          quarantineReason: 'CHECKSUM_MISMATCH',
          flaggedAt: expect.any(Date),
        }),
      }),
    );
    expect(alerts.sendSlackAlert).toHaveBeenCalledWith(expect.stringContaining(documentId));
  });

  it('accepts matching checksums and moves documents to pending review', async () => {
    const { service, prisma } = createDocumentsServiceHarness();

    const result = await service.confirmMemberUpload(tenantId, userId, {
      documentId,
      checksum: uploadedChecksum,
      uploadToken,
    });

    expect(result).toMatchObject({ id: documentId, status: DocumentStatus.PENDING_REVIEW });
    expect(prisma.document.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: documentId,
          tenantId,
          memberId,
          uploadToken,
          uploadConfirmed: false,
        }),
        data: expect.objectContaining({
          status: DocumentStatus.PENDING_REVIEW,
          uploadConfirmed: true,
          uploadToken: null,
          uploadTokenExpires: null,
          checksum: uploadedChecksum,
        }),
      }),
    );
  });
});

function createDocumentsServiceHarness() {
  const documentRecord = {
    id: documentId,
    tenantId,
    memberId,
    uploadedById: userId,
    objectKey: `tenants/${tenantId}/members/${memberId}/national_id_front_1_test.jpg`,
    originalFileName: 'test.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: uploadedBytes.length,
    checksum: null,
    type: DocumentType.NATIONAL_ID_FRONT,
    status: DocumentStatus.PENDING_UPLOAD,
    version: 1,
    reviewedById: null,
    reviewedAt: null,
    rejectionReason: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    member: { id: memberId, kycStatus: KycStatus.APPROVED },
  };

  const prisma = {
    member: {
      findFirst: jest.fn().mockResolvedValue({ id: memberId, kycStatus: KycStatus.APPROVED }),
      update: jest.fn().mockResolvedValue(undefined),
    },
    document: {
      create: jest.fn().mockResolvedValue({ id: documentId, objectKey: documentRecord.objectKey }),
      findFirst: jest.fn().mockImplementation(async (args: { orderBy?: { version?: string } }) => {
        if (args?.orderBy?.version === 'desc') return null;
        return documentRecord;
      }),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        ...documentRecord,
        status: DocumentStatus.PENDING_REVIEW,
        expiresAt: null,
        uploadConfirmed: true,
      }),
      update: jest.fn().mockResolvedValue({
        ...documentRecord,
        status: DocumentStatus.QUARANTINE,
        quarantineReason: 'CHECKSUM_MISMATCH',
      }),
    },
  };

  const audit = {
    create: jest.fn().mockResolvedValue(undefined),
  };

  const storage = {
    getUploadUrlForKey: jest
      .fn()
      .mockImplementation(async (params: { objectKey: string; expiresIn: number }) => ({
        uploadUrl: `https://storage.test/${encodeURIComponent(params.objectKey)}`,
        objectKey: params.objectKey,
        expiresIn: params.expiresIn,
      })),
    headFile: jest.fn().mockResolvedValue({
      contentLength: uploadedBytes.length,
      contentType: 'image/jpeg',
      eTag: '"test-etag"',
      lastModified: new Date(),
    }),
    validateUploadedSize: jest.fn().mockResolvedValue(undefined),
    getFileStream: jest.fn().mockResolvedValue(
      (async function* () {
        yield uploadedBytes;
      })(),
    ),
    deleteFile: jest.fn().mockResolvedValue(undefined),
  };

  const cleanupQueue = {
    add: jest.fn().mockResolvedValue({ id: 'cleanup-job' }),
  };

  const kycReviewQueue = {
    add: jest.fn().mockResolvedValue({ id: 'kyc-job' }),
  };

  const alerts = {
    sendSlackAlert: jest.fn().mockResolvedValue(undefined),
    sendOpsEmail: jest.fn().mockResolvedValue(undefined),
  };

  const service = new DocumentsService(
    prisma as never,
    audit as never,
    storage as never,
    alerts as never,
    cleanupQueue as never,
    kycReviewQueue as never,
  );

  return {
    service,
    prisma,
    documentRecord,
    audit,
    storage,
    alerts,
    cleanupQueue,
    kycReviewQueue,
  };
}
