import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  MinLength,
  IsOptional,
  Matches,
  ValidateIf,
} from 'class-validator';
import { UserRole } from '@prisma/client';

export class LoginDto {
  @ApiPropertyOptional({
    example: 'admin@kcboda.co.ke',
    description: 'User email address (provide email OR phone)',
  })
  @ValidateIf((o: LoginDto) => !o.phone)
  @IsEmail({}, { message: 'Provide a valid email address' })
  email?: string;

  @ApiPropertyOptional({
    example: '+254712345678',
    description: 'Phone number (provide email OR phone)',
  })
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

  @ApiProperty({ type: LoginUserDto })
  user!: LoginUserDto;
}
