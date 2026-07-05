import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';

/**
 * Roles that can be assigned via POST /users (admin channel) and PATCH /users/:id.
 * MEMBER is created via /auth/register; SUPER_ADMIN is platform-only.
 * Shared with update-user.dto.ts so the two endpoints can never drift apart.
 */
export const ASSIGNABLE_ROLES = [
  UserRole.TENANT_ADMIN,
  UserRole.MANAGER,
  UserRole.LOAN_OFFICER,
  UserRole.TELLER,
  UserRole.AUDITOR,
  UserRole.MEMBER,
  UserRole.CHAIRMAN,
  UserRole.ACCOUNTANT,
] as const;

export class CreateUserDto {
  @ApiProperty({ example: 'jane.doe@saccobank.co.ke' })
  @IsEmail()
  email!: string;

  @ApiProperty({
    description:
      'Temporary password — user will be forced to change on first login. ' +
      'Min 8 chars, must include uppercase, lowercase, and a digit.',
    example: 'Temp@2025',
  })
  @IsString()
  @MinLength(8)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Password must contain at least one uppercase letter, one lowercase letter, and one digit',
  })
  password!: string;

  @ApiProperty({ example: 'Jane' })
  @IsString()
  firstName!: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  lastName!: string;

  @ApiPropertyOptional({ example: '+254712345678' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({
    enum: ASSIGNABLE_ROLES,
    description: 'Role to assign. SUPER_ADMIN is not assignable via this endpoint.',
    example: UserRole.TELLER,
  })
  @IsEnum(ASSIGNABLE_ROLES)
  role!: UserRole;
}
