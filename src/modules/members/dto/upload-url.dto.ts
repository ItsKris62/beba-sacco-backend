import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RequestUploadUrlDto {
  @ApiProperty({
    example: 'national_id_front.jpg',
    description: 'Original file name — used only to determine the extension label',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({
    example: 'image/jpeg',
    description: 'MIME content type. Allowed: image/jpeg, image/png, image/webp, application/pdf',
    enum: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  })
  @IsString()
  @IsNotEmpty()
  contentType!: string;
}

export class UploadUrlResponseDto {
  @ApiProperty({ description: 'Pre-signed PUT URL — valid for 5 minutes' })
  uploadUrl!: string;

  @ApiProperty({ description: 'Object key to persist on the document record after upload' })
  objectKey!: string;

  @ApiProperty({ example: 300, description: 'Seconds until the URL expires' })
  expiresIn!: number;
}
