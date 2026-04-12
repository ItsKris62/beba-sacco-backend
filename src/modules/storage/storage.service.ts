import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Storage Service
 * 
 * Cloudflare R2 (S3-compatible) integration
 * 
 * Use cases:
 * - Member documents (ID, KRA PIN)
 * - Loan application documents
 * - Report exports (PDF, Excel)
 * - Profile pictures
 * 
 * TODO: Phase 2 - Implement upload with pre-signed URLs
 * TODO: Phase 2 - Add file type validation
 * TODO: Phase 3 - Add virus scanning integration
 * TODO: Phase 4 - Add automatic file cleanup/archival
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(private readonly configService: ConfigService) {
    const accountId = this.configService.get<string>('app.r2.accountId', '');
    this.bucketName = this.configService.get<string>('app.r2.bucketName', '');

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this.configService.get<string>('app.r2.accessKeyId', ''),
        secretAccessKey: this.configService.get<string>('app.r2.secretAccessKey', ''),
      },
    });
  }

  /**
   * Generate pre-signed URL for upload
   * Frontend uses this URL to upload files directly to R2
   * 
   * TODO: Phase 2 - Implement
   */
  async getUploadUrl(
    key: string,
    contentType: string,
    expiresIn: number = 3600,
  ): Promise<string> {
    // TODO: Phase 2
    // 1. Validate file type
    // 2. Generate unique key with tenant/user prefix
    // 3. Create PutObjectCommand
    // 4. Generate signed URL
    // 5. Return URL to frontend

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: contentType,
    });

    return getSignedUrl(this.s3Client, command, { expiresIn });
  }

  /**
   * Generate pre-signed URL for download
   * 
   * TODO: Phase 2 - Implement
   */
  async getDownloadUrl(key: string, expiresIn: number = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    return getSignedUrl(this.s3Client, command, { expiresIn });
  }

  /**
   * Delete file
   * TODO: Phase 3 - Implement
   */
  async deleteFile(key: string): Promise<void> {
    throw new Error('Not implemented - Phase 3');
  }

  /**
   * List files by prefix
   * TODO: Phase 3 - Implement
   */
  async listFiles(prefix: string): Promise<string[]> {
    throw new Error('Not implemented - Phase 3');
  }
}

