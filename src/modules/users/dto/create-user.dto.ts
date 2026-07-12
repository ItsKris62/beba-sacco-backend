import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsPhoneNumber, IsString } from 'class-validator';
import { UserRole } from '@prisma/client';

/**
 * Roles that can be assigned via PATCH /users/:id (reassigning an existing
 * account, which for MEMBER/CHAIRMAN already has a linked Member profile).
 * MEMBER is created via /auth/register; SUPER_ADMIN is platform-only.
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

/**
 * Roles that can be assigned via POST /users (creates a brand-new staff account).
 * Excludes MEMBER and CHAIRMAN; use the member-management flow for those roles.
 */
export const STAFF_ASSIGNABLE_ROLES = [
  UserRole.TENANT_ADMIN,
  UserRole.MANAGER,
  UserRole.LOAN_OFFICER,
  UserRole.TELLER,
  UserRole.AUDITOR,
  UserRole.ACCOUNTANT,
] as const;

export class CreateUserDto {
  @ApiProperty({
    example: 'jane.doe@saccobank.co.ke',
    description: 'Required staff email. The temporary password is delivered here.',
  })
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
    description: 'Optional staff phone number. Temporary passwords are delivered by email.',
    required: false,
  })
  @IsOptional()
  @IsPhoneNumber('KE', { message: 'Must be a valid Kenyan phone number' })
  phone?: string;

  @ApiProperty({
    enum: STAFF_ASSIGNABLE_ROLES,
    description:
      'Role to assign. SUPER_ADMIN is not assignable via this endpoint. MEMBER and CHAIRMAN ' +
      'are not assignable here; use Members Management instead.',
    example: UserRole.TELLER,
  })
  @IsEnum(STAFF_ASSIGNABLE_ROLES, {
    message: `role must be one of: ${STAFF_ASSIGNABLE_ROLES.join(', ')} (use POST /members to create a MEMBER or CHAIRMAN account)`,
  })
  role!: UserRole;
}
