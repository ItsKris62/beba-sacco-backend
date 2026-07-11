import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsNotEmpty, IsPhoneNumber, IsString } from 'class-validator';
import { UserRole } from '@prisma/client';

/**
 * Roles that can be assigned via PATCH /users/:id (reassigning an *existing*
 * account, which — for MEMBER/CHAIRMAN — already has a linked Member profile).
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
 * Roles that can be assigned via POST /users (creates a *brand-new* account).
 * Excludes MEMBER and CHAIRMAN — creating a User with one of those roles here
 * would never get a linked Member row (that only happens via /auth/register or
 * POST /members), leaving an orphaned staff-style login with member-level
 * access and no member profile. Use Members Management → Create Member instead.
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
      'Required — a server-generated temporary password is sent to this number via SMS. ' +
      'The user logs in with the temp password, verifies their phone via a 6-digit SMS OTP, ' +
      'and is then forced to set a permanent password.',
  })
  @IsNotEmpty({ message: 'Phone number is required for temporary password delivery' })
  @IsPhoneNumber('KE', { message: 'Must be a valid Kenyan phone number' })
  phone!: string;

  @ApiProperty({
    enum: STAFF_ASSIGNABLE_ROLES,
    description:
      'Role to assign. SUPER_ADMIN is not assignable via this endpoint. MEMBER and CHAIRMAN ' +
      'are not assignable here either — use Members Management (POST /members) instead, ' +
      'which links to an existing self-registered User and provisions a Member profile.',
    example: UserRole.TELLER,
  })
  @IsEnum(STAFF_ASSIGNABLE_ROLES, {
    message: `role must be one of: ${STAFF_ASSIGNABLE_ROLES.join(', ')} (use POST /members to create a MEMBER or CHAIRMAN account)`,
  })
  role!: UserRole;
}
