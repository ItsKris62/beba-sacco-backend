import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsInt, IsOptional, IsString, IsUrl, Length, Min, Max, IsBoolean, ValidateNested } from 'class-validator';

export class UpdateTenantSettingsDto {
  @ApiPropertyOptional({
    description: 'Maximum concurrent guarantees a member can have',
    default: 3,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxConcurrentGuarantees?: number;

  @ApiPropertyOptional({ description: 'Organization / SACCO name shown across the platform' })
  @IsOptional()
  @IsString()
  @Length(2, 200)
  name?: string;

  @ApiPropertyOptional({ description: 'Public contact email for the organization' })
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional({ description: 'Public contact phone number(s) for the organization' })
  @IsOptional()
  @IsString()
  @Length(7, 40)
  contactPhone?: string;

  @ApiPropertyOptional({ description: 'Physical / postal address' })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  address?: string;

  @ApiPropertyOptional({ description: 'Public URL of the organization logo' })
  @IsOptional()
  @IsUrl()
  logoUrl?: string;

  @ApiPropertyOptional({ description: 'Security settings for the tenant' })
  @IsOptional()
  @ValidateNested()
  @Type(() => SecuritySettingsDto)
  security?: SecuritySettingsDto;
}

export class PasswordPolicyDto {
  @IsOptional()
  @IsInt()
  @Min(8)
  @Max(128)
  minLength?: number;

  @IsOptional()
  @IsBoolean()
  requireComplexity?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  expiryDays?: number;
}

export class SecuritySettingsDto {
  @IsOptional()
  @IsBoolean()
  require2FA?: boolean;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(10080)
  sessionTimeoutMinutes?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => PasswordPolicyDto)
  passwordPolicy?: PasswordPolicyDto;
}
