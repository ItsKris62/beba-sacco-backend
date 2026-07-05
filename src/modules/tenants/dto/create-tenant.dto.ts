import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, IsUrl, Length, Matches } from 'class-validator';

export class CreateTenantDto {
  @ApiProperty({ description: 'SACCO / organization display name' })
  @IsString()
  @Length(2, 200)
  name!: string;

  @ApiProperty({ description: 'URL-safe unique tenant slug', example: 'kc-boda-sacco' })
  @IsString()
  @Matches(/^[a-z0-9-]+$/, { message: 'slug must be lowercase letters, numbers, and hyphens only' })
  @Length(2, 100)
  slug!: string;

  @ApiProperty({
    description: 'Reserved Phase 3 per-tenant schema name (not yet used for routing)',
    example: 'kc_boda_sacco',
  })
  @IsString()
  @Matches(/^[a-z0-9_]+$/, { message: 'schemaName must be lowercase letters, numbers, and underscores only' })
  @Length(2, 100)
  schemaName!: string;

  @ApiProperty({ description: 'Primary contact email for the organization' })
  @IsEmail()
  contactEmail!: string;

  @ApiProperty({ description: 'Primary contact phone for the organization' })
  @IsString()
  @Length(7, 40)
  contactPhone!: string;

  @ApiPropertyOptional({ description: 'Physical / postal address' })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  address?: string;

  @ApiPropertyOptional({ description: 'Public URL of the organization logo' })
  @IsOptional()
  @IsUrl()
  logoUrl?: string;
}
