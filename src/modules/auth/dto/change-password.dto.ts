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
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/, {
    message:
      'Password must contain at least one uppercase letter, one lowercase letter, one digit, and one special character (@$!%*?&)',
  })
  newPassword!: string;

  @ApiPropertyOptional({
    description: 'Current access token JTI — sent by frontend to enable immediate revocation',
  })
  @IsString()
  @IsOptional()
  accessTokenJti?: string;
}
