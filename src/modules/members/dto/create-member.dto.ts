import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsDateString,
  Matches,
  IsUUID,
} from 'class-validator';

/**
 * Admin/Manager creates a Member profile for an existing User.
 * Tenant is derived from X-Tenant-ID header — never from the body.
 */
export class CreateMemberDto {
  @ApiProperty({
    description: 'UUID of the User account to link as a member',
    example: 'a1b2c3d4-...',
  })
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({ example: '12345678' })
  @IsOptional()
  @IsString()
  nationalId?: string;

  @ApiPropertyOptional({ example: 'A001234567Z' })
  @IsOptional()
  @IsString()
  kraPin?: string;

  @ApiPropertyOptional({ example: 'Nairobi County' })
  @IsOptional()
  @IsString()
  employer?: string;

  @ApiPropertyOptional({ example: 'Boda-boda rider' })
  @IsOptional()
  @IsString()
  occupation?: string;

  @ApiPropertyOptional({ example: '1990-06-15', description: 'ISO 8601 date string' })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;
}
