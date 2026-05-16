import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentStatus, DocumentType } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export const MAX_DOCUMENT_UPLOAD_BYTES = 5 * 1024 * 1024;

export class RequestDocumentUploadUrlDto {
  @ApiProperty({ enum: DocumentType, example: DocumentType.NATIONAL_ID_FRONT })
  @IsEnum(DocumentType)
  type!: DocumentType;

  @ApiPropertyOptional({ example: 'national_id_front.jpg', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  originalFileName?: string;

  @ApiProperty({
    example: 'image/jpeg',
    enum: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  })
  @IsString()
  @IsNotEmpty()
  mimeType!: string;

  @ApiPropertyOptional({ example: 734003, maximum: MAX_DOCUMENT_UPLOAD_BYTES })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_DOCUMENT_UPLOAD_BYTES)
  sizeBytes?: number;

  @ApiPropertyOptional({
    description: 'Backward-compatible alias for sizeBytes',
    example: 734003,
    maximum: MAX_DOCUMENT_UPLOAD_BYTES,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_DOCUMENT_UPLOAD_BYTES)
  fileSize?: number;

  @ApiPropertyOptional({
    description: 'Optional frontend SHA-256 checksum for integrity tracking',
    example: 'f'.repeat(64),
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i, { message: 'checksum must be a 64-character SHA-256 hex digest' })
  checksum?: string;
}

export class DocumentUploadUrlResponseDto {
  @ApiProperty({ format: 'uuid' })
  documentId!: string;

  @ApiProperty()
  uploadUrl!: string;

  @ApiProperty({ description: 'Backward-compatible alias for uploadUrl' })
  preSignedUrl!: string;

  @ApiProperty()
  objectKey!: string;

  @ApiProperty({ example: 3600 })
  expiresIn!: number;

  @ApiProperty({ example: MAX_DOCUMENT_UPLOAD_BYTES })
  maxBytes!: number;
}

export class ConfirmDocumentUploadDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  documentId!: string;

  @ApiPropertyOptional({
    description: 'Optional frontend SHA-256 checksum calculated after file selection',
    example: 'a'.repeat(64),
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i, { message: 'checksum must be a 64-character SHA-256 hex digest' })
  checksum?: string;
}

export class ReviewDocumentDto {
  @ApiProperty({ enum: [DocumentStatus.APPROVED, DocumentStatus.REJECTED] })
  @IsEnum(DocumentStatus)
  status!: DocumentStatus;

  @ApiPropertyOptional({ maxLength: 1000 })
  @ValidateIf((dto: ReviewDocumentDto) => dto.status === DocumentStatus.REJECTED)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  rejectionReason?: string;
}

export class AdminDocumentQueryDto {
  @ApiPropertyOptional({ enum: DocumentStatus })
  @IsOptional()
  @IsEnum(DocumentStatus)
  status?: DocumentStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  memberId?: string;
}

export class AdminRequestDocumentUploadUrlDto extends RequestDocumentUploadUrlDto {
  @ApiProperty({ format: 'uuid', description: 'The UUID of the member to upload the document for' })
  @IsUUID()
  memberId!: string;
}

export class AdminConfirmDocumentUploadDto extends ConfirmDocumentUploadDto {
  @ApiProperty({ format: 'uuid', description: 'The UUID of the member to confirm the document upload for' })
  @IsUUID()
  memberId!: string;
}
