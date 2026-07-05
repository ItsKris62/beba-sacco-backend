import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

const ALLOWED_LOGO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

export class RequestLogoUploadUrlDto {
  @ApiProperty({ description: 'Original file name (used for extension only)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ description: 'MIME type of the logo image', enum: ALLOWED_LOGO_CONTENT_TYPES })
  @IsString()
  @IsIn(ALLOWED_LOGO_CONTENT_TYPES)
  contentType!: string;
}
