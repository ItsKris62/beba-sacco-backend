import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';

/** Allowed MIME types for document uploads */
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

const UPLOAD_URL_TTL = 300; // 5 minutes

/**
 * Storage Service
 *
 * S3-compatible integration supporting both Cloudflare R2 (production)
 * and MinIO (local / staging via R2_ENDPOINT override).
 *
 * Pre-signed URL flow:
 *  1. Client calls POST /members/documents/upload-url with { fileName, contentType }
 *  2. Server returns { uploadUrl, objectKey, expiresIn }
 *  3. Client PUTs the file directly to the signed URL (no data passes through server)
 *  4. Client stores objectKey and calls the appropriate record-update endpoint
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(private readonly configService: ConfigService) {
    const accountId = this.configService.get<string>('app.r2.accountId', '');
    this.bucketName = this.configService.get<string>('app.r2.bucketName', '');

    // R2_ENDPOINT overrides the default Cloudflare endpoint — used for MinIO in dev/staging
    const endpointOverride = process.env.R2_ENDPOINT;

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: endpointOverride ?? `https://${accountId}.r2.cloudflarestorage.com`,
      // MinIO requires path-style; R2 uses virtual-hosted by default
      forcePathStyle: !!endpointOverride,
      credentials: {
        accessKeyId: this.configService.get<string>('app.r2.accessKeyId', ''),
        secretAccessKey: this.configService.get<string>('app.r2.secretAccessKey', ''),
      },
    });
  }

  /**
   * Generate a pre-signed PUT URL for direct browser-to-storage upload.
   *
   * @param tenantId  Scopes the object key so tenants cannot overwrite each other's files
   * @param memberId  Further namespaces the key under the member
   * @param fileName  Original file name (used for extension only — never trusted for the key)
   * @param contentType  Must be in ALLOWED_CONTENT_TYPES
   * @returns { uploadUrl, objectKey, expiresIn }
   */
  async getUploadUrl(params: {
    tenantId: string;
    memberId: string;
    fileName: string;
    contentType: string;
  }): Promise<{ uploadUrl: string; objectKey: string; expiresIn: number }> {
    if (!ALLOWED_CONTENT_TYPES.has(params.contentType)) {
      throw new BadRequestException(
        `Unsupported content type "${params.contentType}". ` +
        `Allowed: ${[...ALLOWED_CONTENT_TYPES].join(', ')}`,
      );
    }

    // Derive extension from the declared content type (never from user-supplied filename)
    const ext = params.contentType.split('/')[1].replace('jpeg', 'jpg');
    const objectKey = `tenants/${params.tenantId}/members/${params.memberId}/${uuidv4()}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ContentType: params.contentType,
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, { expiresIn: UPLOAD_URL_TTL });

    return { uploadUrl, objectKey, expiresIn: UPLOAD_URL_TTL };
  }

  /**
   * Generate a pre-signed GET URL for secure file download.
   */
  async getDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });
    return getSignedUrl(this.s3Client, command, { expiresIn });
  }

  /**
   * Delete a stored object.
   */
  async deleteFile(key: string): Promise<void> {
    const command = new DeleteObjectCommand({ Bucket: this.bucketName, Key: key });
    await this.s3Client.send(command);
    this.logger.log(`Deleted object: ${key}`);
  }

  /**
   * List objects by prefix (e.g., all documents for a member).
   */
  async listFiles(prefix: string): Promise<string[]> {
    const command = new ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: prefix,
    });
    const response = await this.s3Client.send(command);
    return (response.Contents ?? []).map((obj) => obj.Key ?? '').filter(Boolean);
  }
}

