import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({ description: 'Current password' })
  @IsString()
  currentPassword!: string;

  @ApiProperty({
    description:
      'New password. Min 8 chars, must include uppercase, lowercase, digit, and special character (@$!%*?&).',
    example: 'NewSecure@2025',
  })
  @IsString()
  @MinLength(8)
  newPassword!: string;

  @ApiPropertyOptional({
    description: 'Current access token JTI — sent by frontend to enable immediate revocation',
  })
  @IsString()
  @IsOptional()
  accessTokenJti?: string;
}
