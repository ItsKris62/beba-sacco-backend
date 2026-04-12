import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength, Matches, IsOptional } from 'class-validator';

/**
 * Self-registration DTO.
 *
 * Role is always MEMBER — elevated-role accounts are created via POST /users (Phase 2).
 * Tenant is derived from the X-Tenant-ID header (TenantInterceptor), NOT the request body.
 */
export class RegisterDto {
  @ApiProperty({ example: 'john.doe@kcboda.co.ke' })
  @IsEmail({}, { message: 'Provide a valid email address' })
  email!: string;

  @ApiProperty({
    example: 'SecurePassword123!',
    minLength: 8,
    description:
      'Must contain uppercase, lowercase, digit, and a special character (@$!%*?&)',
  })
  @IsString()
  @MinLength(8)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/, {
    message: 'Password too weak: needs uppercase, lowercase, digit, and special char (@$!%*?&)',
  })
  password!: string;

  @ApiProperty({ example: 'John' })
  @IsString()
  firstName!: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  lastName!: string;

  @ApiPropertyOptional({ example: '+254712345678' })
  @IsOptional()
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, { message: 'Provide a valid phone number' })
  phone?: string;
}
