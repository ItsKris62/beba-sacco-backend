import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import * as Sentry from '@sentry/nestjs';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { QUEUE_NAMES, DocumentIngestionJobPayload } from '../../queue/queue.constants';

// Mirrors ALLOWED_MIME_TYPES / MAX_DOCUMENT_UPLOAD_BYTES in documents.service.ts —
// duplicated rather than imported to keep this worker-only processor decoupled from
// DocumentsService's larger dependency graph (storage upload-URL flow, BullMQ queues
// it itself injects, etc.), which this processor doesn't need.
const MAX_INGEST_BYTES = 5 * 1024 * 1024;
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'image/heic': 'heic',
  'image/heif': 'heif',
};
const ALLOWED_INGEST_CONTENT_TYPES = new Set(Object.keys(EXTENSION_BY_CONTENT_TYPE));

/**
 * DocumentIngestionProcessor
 *
 * Fetches a document currently sitting at an external URL (Document.objectKey holds
 * the raw URL — see onboarding.service.ts and DocumentsService#resolveDownloadUrl's
 * isExternalUrl fallback) and re-hosts it in the managed R2/MinIO bucket, so the KYC
 * Queue's download action no longer depends on a third-party link staying alive.
 *
 * On any failure the Document row is left untouched — objectKey still holds the
 * external URL, so resolveDownloadUrl's fallback keeps the document downloadable
 * (degraded but functional) until ingestion succeeds on a retry or is fixed manually.
 */
@Processor(QUEUE_NAMES.DOCUMENT_INGESTION, { concurrency: 2 })
export class DocumentIngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentIngestionProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {
    super();
  }

  async process(job: Job<DocumentIngestionJobPayload>): Promise<void> {
    const { tenantId, documentId, memberId, sourceUrl } = job.data;
    this.logger.log(`Document ingestion job ${job.id}: doc=${documentId} member=${memberId}`);

    if (!/^https?:\/\//i.test(sourceUrl)) {
      this.logger.warn(
        `Job ${job.id}: sourceUrl "${sourceUrl}" is not http(s) — nothing to ingest`,
      );
      return;
    }

    const document = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId, memberId },
      select: { id: true, objectKey: true },
    });
    if (!document) {
      this.logger.warn(`Job ${job.id}: document ${documentId} no longer exists — skipping`);
      return;
    }
    if (document.objectKey !== sourceUrl) {
      // Already ingested (or the objectKey was otherwise replaced since this job was
      // queued) — don't clobber whatever is there now.
      this.logger.log(`Job ${job.id}: document ${documentId} objectKey already changed — skipping`);
      return;
    }

    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`Fetch failed for ${sourceUrl}: HTTP ${response.status}`);
    }

    const declaredLength = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_INGEST_BYTES) {
      throw new Error(
        `Document at ${sourceUrl} declares ${declaredLength} bytes, exceeds ${MAX_INGEST_BYTES}`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_INGEST_BYTES) {
      throw new Error(
        `Document at ${sourceUrl} is ${buffer.byteLength} bytes, exceeds ${MAX_INGEST_BYTES}`,
      );
    }
    if (buffer.byteLength === 0) {
      throw new Error(`Document at ${sourceUrl} returned an empty body`);
    }

    const headerContentType = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const contentType = ALLOWED_INGEST_CONTENT_TYPES.has(headerContentType)
      ? headerContentType
      : this.inferContentTypeFromUrl(sourceUrl);

    if (!contentType) {
      // Header didn't declare a recognized document type and the URL's own extension
      // didn't help either — likely an error page, redirect, or expired link rather
      // than a real document. Fail the job instead of uploading unknown bytes.
      throw new Error(
        `Unrecognized content for ${sourceUrl} (content-type: "${headerContentType || '(none)'}")` +
          ' — likely not a real document (expired link, error page, etc.)',
      );
    }

    const extension = EXTENSION_BY_CONTENT_TYPE[contentType];
    const objectKey = `tenants/${tenantId}/members/${memberId}/ingested/${uuidv4()}.${extension}`;

    await this.storage.uploadBuffer(objectKey, buffer, contentType);

    await this.prisma.document.update({
      where: { id: document.id },
      data: {
        objectKey,
        mimeType: contentType,
        sizeBytes: buffer.byteLength,
      },
    });

    this.logger.log(`Document ingestion job ${job.id} completed: doc=${documentId} → ${objectKey}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<DocumentIngestionJobPayload>, error: Error): void {
    const maxAttempts = job.opts?.attempts ?? 5;
    if (job.attemptsMade < maxAttempts) {
      return;
    }

    this.logger.error(
      `Document ingestion job ${job.id} exhausted retries (${maxAttempts}) for document ` +
        `${job.data.documentId} — leaving objectKey as the external URL; resolveDownloadUrl's ` +
        'fallback keeps it downloadable in the meantime.',
      error.message,
    );
    Sentry.captureMessage('Document ingestion permanently failed', {
      level: 'warning',
      extra: {
        documentId: job.data.documentId,
        memberId: job.data.memberId,
        tenantId: job.data.tenantId,
        sourceUrl: job.data.sourceUrl,
        error: error.message,
      },
    });
  }

  /** Best-effort content-type guess from a URL's file extension, when the response
   * didn't declare (or lied about) its Content-Type — mirrors the same fallback
   * onboarding.service.ts uses when it first seeds the Document row. */
  private inferContentTypeFromUrl(url: string): string | undefined {
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
    return ext ? byExtension[ext] : undefined;
  }
}
