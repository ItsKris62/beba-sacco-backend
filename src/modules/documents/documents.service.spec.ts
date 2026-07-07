import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { BadRequestException } from '@nestjs/common';
import { DocumentType } from '@prisma/client';
import { DocumentsService } from './documents.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { QUEUE_NAMES } from '../queue/queue.constants';
import type { RequestDocumentUploadUrlDto } from './dto/document.dto';

// This spec covers only the HEIC/HEIF support and application/octet-stream
// extension-fallback added to the upload MIME validation — not the full
// upload flow (presigning, R2/MinIO, confirm/checksum), which needs the
// heavier fixtures the rest of DocumentsService's public methods already
// depend on.

const mockQueue = { add: jest.fn() };

function buildDto(overrides: Partial<RequestDocumentUploadUrlDto> = {}): RequestDocumentUploadUrlDto {
  return {
    type: DocumentType.NATIONAL_ID_FRONT,
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    originalFileName: 'id.jpg',
    ...overrides,
  } as RequestDocumentUploadUrlDto;
}

describe('DocumentsService — HEIC/HEIF + octet-stream fallback', () => {
  let service: DocumentsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentsService,
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: getQueueToken(QUEUE_NAMES.DOCUMENT_CLEANUP), useValue: mockQueue },
        { provide: getQueueToken(QUEUE_NAMES.KYC_REVIEW), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<DocumentsService>(DocumentsService);
  });

  describe('assertUploadPayload()', () => {
    const assertUploadPayload = (dto: RequestDocumentUploadUrlDto) =>
      (service as any).assertUploadPayload(dto);

    it('accepts image/heic', () => {
      expect(() => assertUploadPayload(buildDto({ mimeType: 'image/heic', originalFileName: 'id.heic' }))).not.toThrow();
    });

    it('accepts image/heif', () => {
      expect(() => assertUploadPayload(buildDto({ mimeType: 'image/heif', originalFileName: 'id.heif' }))).not.toThrow();
    });

    it('falls back to the file extension when mimeType is application/octet-stream', () => {
      expect(() =>
        assertUploadPayload(buildDto({ mimeType: 'application/octet-stream', originalFileName: 'id.jpg' })),
      ).not.toThrow();
    });

    it('accepts a HEIC file reported as application/octet-stream, via the extension fallback', () => {
      expect(() =>
        assertUploadPayload(buildDto({ mimeType: 'application/octet-stream', originalFileName: 'id.heic' })),
      ).not.toThrow();
    });

    it('rejects application/octet-stream when there is no originalFileName to fall back on', () => {
      expect(() =>
        assertUploadPayload(buildDto({ mimeType: 'application/octet-stream', originalFileName: undefined })),
      ).toThrow(BadRequestException);
    });

    it('rejects application/octet-stream when the file extension is not in the allowed list', () => {
      expect(() =>
        assertUploadPayload(buildDto({ mimeType: 'application/octet-stream', originalFileName: 'payload.exe' })),
      ).toThrow(BadRequestException);
    });

    it('still rejects an unsupported, trustworthy MIME type outright (no extension fallback applies)', () => {
      expect(() =>
        assertUploadPayload(buildDto({ mimeType: 'image/gif', originalFileName: 'id.jpg' })),
      ).toThrow(BadRequestException);
    });
  });

  describe('extensionFor()', () => {
    const extensionFor = (mimeType: string, originalFileName?: string) =>
      (service as any).extensionFor(mimeType, originalFileName);

    it('returns "heic" for image/heic', () => {
      expect(extensionFor('image/heic')).toBe('heic');
    });

    it('returns "heif" for image/heif', () => {
      expect(extensionFor('image/heif')).toBe('heif');
    });

    it('falls back to the extension derived from the file name for an unrecognized MIME type', () => {
      expect(extensionFor('application/octet-stream', 'id-front.heic')).toBe('heic');
    });

    it('throws when the MIME type is unrecognized and no usable file name is given', () => {
      expect(() => extensionFor('application/octet-stream', undefined)).toThrow(BadRequestException);
    });
  });
});
