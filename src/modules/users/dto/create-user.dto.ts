import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsString, Matches } from 'class-validator';
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

  @ApiProperty({ example: 'Jane' })
  @IsString()
  firstName!: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  lastName!: string;

  @ApiProperty({
    example: '+254712345678',
    description:
      'Required — a temporary login PIN is sent to this number via SMS. ' +
      'The user logs in with phone + PIN and is then forced to set a permanent password.',
  })
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, { message: 'Provide a valid phone number' })
  phone!: string;

  @ApiProperty({
    enum: ASSIGNABLE_ROLES,
    description: 'Role to assign. SUPER_ADMIN is not assignable via this endpoint.',
    example: UserRole.TELLER,
  })
  @IsEnum(ASSIGNABLE_ROLES)
  role!: UserRole;
}
