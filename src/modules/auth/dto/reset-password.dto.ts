import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    description: 'The signed reset token received via email',
  })
  @IsString()
  token!: string;

  @ApiProperty({
    description:
      'New password. Min 8 chars, must include uppercase, lowercase, digit, and special character.',
    example: 'NewSecure@2025!',
  })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  newPassword!: string;

  @ApiPropertyOptional({
    description: 'Current access token JTI — sent when resetting while logged in',
  })
  @IsString()
  @IsOptional()
  accessTokenJti?: string;
}
