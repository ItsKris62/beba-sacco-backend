import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ProfileImageUploadUrlRequestDto {
  @ApiProperty({
    example: 'avatar.jpg',
    description: 'Original image file name. Allowed extensions: jpg, jpeg, png, webp.',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName!: string;
}

export class ProfileImageUploadUrlResponseDto {
  @ApiProperty({ description: 'Pre-signed PUT URL for direct browser-to-R2 upload' })
  uploadUrl!: string;

  @ApiProperty({ description: 'R2 object key to save on the user profile' })
  fileKey!: string;

  @ApiProperty({ example: 'image/jpeg', description: 'Content-Type expected by the signed PUT URL' })
  contentType!: string;

  @ApiProperty({ example: 300, description: 'Seconds until the URL expires' })
  expiresIn!: number;
}

export class ProfileImageUrlResponseDto {
  @ApiPropertyOptional({ nullable: true, description: 'Pre-signed GET URL for the current profile image' })
  imageUrl!: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Persisted R2 object key' })
  fileKey!: string | null;
}
