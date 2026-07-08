import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsNotEmpty, IsPhoneNumber, IsString } from 'class-validator';
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
      'Required — a server-generated temporary password is sent to this number via SMS. ' +
      'The user logs in with the temp password, verifies their phone via a 6-digit SMS OTP, ' +
      'and is then forced to set a permanent password.',
  })
  @IsNotEmpty({ message: 'Phone number is required for temporary password delivery' })
  @IsPhoneNumber('KE', { message: 'Must be a valid Kenyan phone number' })
  phone!: string;

  @ApiProperty({
    enum: ASSIGNABLE_ROLES,
    description: 'Role to assign. SUPER_ADMIN is not assignable via this endpoint.',
    example: UserRole.TELLER,
  })
  @IsEnum(ASSIGNABLE_ROLES)
  role!: UserRole;
}
