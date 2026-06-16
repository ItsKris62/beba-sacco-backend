import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  MinLength,
  Matches,
  ValidateIf,
  IsEmail,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { UserRole } from '@prisma/client';

export class LoginDto {
  @ApiPropertyOptional({
    example: 'admin@kcboda.co.ke or member.12345678@586c1886.beba.local',
    description:
      'User email address, including system-generated emails such as @import.local or @beba.local (provide email OR phone)',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @ValidateIf((o: LoginDto) => !o.phone)
  @IsEmail(
    { require_tld: false },
    { message: 'Provide a valid email address or system-generated email' },
  )
  email?: string;

  @ApiPropertyOptional({
    example: '+254712345678',
    description: 'Phone number (provide email OR phone)',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((o: LoginDto) => !o.email)
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, { message: 'Provide a valid phone number' })
  phone?: string;

  @ApiProperty({ example: 'SecurePassword123!', minLength: 8 })
  @IsString()
  @MinLength(8)
  password!: string;
}

export class LoginUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty({ enum: UserRole }) role!: UserRole;
  @ApiProperty() tenantId!: string;
  @ApiProperty({ description: 'Force password change before accessing other routes' })
  mustChangePassword!: boolean;
}

export class LoginResponseDto {
  @ApiProperty({ description: 'JWT access token (15 min)' })
  accessToken!: string;

  @ApiProperty({ description: 'JWT refresh token (7 days) – store securely' })
  refreshToken!: string;

  @ApiProperty({
    description: 'Signals clients to remove localStorage refresh-token copies after cookie migration',
  })
  migrateRefreshToken!: boolean;

  @ApiProperty({ type: LoginUserDto })
  user!: LoginUserDto;

  @ApiProperty({
    description: 'Top-level flag clients can use to redirect to the change-password screen',
  })
  requiresPasswordChange!: boolean;
}
