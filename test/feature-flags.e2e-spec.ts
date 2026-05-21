import { DocumentStatus, DocumentType, KycStatus, UserRole } from '@prisma/client';
import { createHash } from 'crypto';
import { FeatureFlags } from '../src/config/feature-flags';
import { DocumentsService } from '../src/modules/documents/documents.service';

const tenantId = '11111111-1111-1111-1111-111111111111';
const userId = '22222222-2222-2222-2222-222222222222';
const memberId = '33333333-3333-3333-3333-333333333333';
const documentId = '44444444-4444-4444-4444-444444444444';
const uploadedBytes = Buffer.from('secure-content');
const uploadedChecksum = createHash('sha256').update(uploadedBytes).digest('hex');

describe('Feature Flags Integration', () => {
  const originalEnv = { ...process.env };
  const restoreEnv = (key: string) => {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = originalEnv[key];
  };

  afterEach(() => {
    restoreEnv('FEATURE_SECURE_UPLOAD_V2');
    restoreEnv('FEATURE_VIRUS_SCAN');
    restoreEnv('FEATURE_VIRUS_SCAN_CANARY_TENANTS');
    jest.clearAllMocks();
  });

  describe('SECURE_UPLOAD_V2 flag', () => {
    it('uses the legacy upload flow when disabled', async () => {
      process.env.FEATURE_SECURE_UPLOAD_V2 = 'false';
      const { service } = createDocumentsServiceHarness();

      const response = await service.requestMemberUploadUrl(tenantId, userId, {
        type: DocumentType.NATIONAL_ID_FRONT,
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        originalFileName: 'test.jpg',
      });

      expect(response).toMatchObject({
        documentId,
        expiresIn: 3600,
        maxBytes: 5 * 1024 * 1024,
      });
      expect(response.uploadToken).toBeUndefined();
    });

    it('uses the secure upload flow when enabled', async () => {
      process.env.FEATURE_SECURE_UPLOAD_V2 = 'true';
      const { service, prisma } = createDocumentsServiceHarness();

      const response = await service.requestMemberUploadUrl(tenantId, userId, {
        type: DocumentType.NATIONAL_ID_BACK,
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        originalFileName: 'test-back.jpg',
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

    it('requires a one-time upload token when confirming secure uploads', async () => {
      process.env.FEATURE_SECURE_UPLOAD_V2 = 'true';
      const { service, prisma } = createDocumentsServiceHarness();

      const first = await service.confirmMemberUpload(tenantId, userId, {
        documentId,
        checksum: uploadedChecksum,
        uploadToken: 'b'.repeat(64),
      });

      expect(first).toMatchObject({ id: documentId, status: DocumentStatus.PENDING_REVIEW });
      expect(prisma.document.updateMany).toHaveBeenCalledTimes(1);

      prisma.document.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        service.confirmMemberUpload(tenantId, userId, {
          documentId,
          checksum: uploadedChecksum,
          uploadToken: 'b'.repeat(64),
        }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('canary flags', () => {
    it('enables canary flags only for configured tenants', () => {
      process.env.FEATURE_VIRUS_SCAN = 'canary';
      process.env.FEATURE_VIRUS_SCAN_CANARY_TENANTS = `${tenantId},other-tenant`;

      expect(FeatureFlags.isEnabled('VIRUS_SCAN', tenantId)).toBe(true);
      expect(FeatureFlags.isEnabled('VIRUS_SCAN', 'not-enabled')).toBe(false);
      expect(FeatureFlags.VIRUS_SCAN).toBe(false);
    });
  });
});

function createDocumentsServiceHarness() {
  const documentRecord = {
    id: documentId,
    tenantId,
    memberId,
    uploadedById: userId,
    objectKey: `tenants/${tenantId}/members/${memberId}/national_id_back_1_test.jpg`,
    originalFileName: 'test.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    checksum: null,
    type: DocumentType.NATIONAL_ID_BACK,
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
        status: DocumentStatus.PENDING_REVIEW,
        expiresAt: null,
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
      contentLength: 1024,
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

  const service = new DocumentsService(
    prisma as never,
    audit as never,
    storage as never,
    cleanupQueue as never,
    kycReviewQueue as never,
  );

  return {
    service,
    prisma,
    audit,
    storage,
    cleanupQueue,
    kycReviewQueue,
  };
}
