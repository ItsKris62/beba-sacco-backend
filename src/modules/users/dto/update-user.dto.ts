import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsEnum, IsBoolean } from 'class-validator';
import { UserRole } from '@prisma/client';

/**
 * Roles that can be assigned via PATCH /users/:id.
 * SUPER_ADMIN is excluded — it is a platform-only role managed outside tenant context.
 */
const UPDATABLE_ROLES = [
  UserRole.TENANT_ADMIN,
  UserRole.MANAGER,
  UserRole.TELLER,
  UserRole.AUDITOR,
  UserRole.MEMBER,
] as const;

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'Jane' })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ example: 'Doe' })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({ example: '+254712345678' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({
    enum: UPDATABLE_ROLES,
    description: 'New role to assign. SUPER_ADMIN cannot be assigned via this endpoint.',
    example: UserRole.TELLER,
  })
  @IsOptional()
  @IsEnum(UPDATABLE_ROLES, {
    message: `role must be one of: ${UPDATABLE_ROLES.join(', ')}`,
  })
  role?: UserRole;

  @ApiPropertyOptional({ example: true, description: 'Set false to reactivate a deactivated user' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
