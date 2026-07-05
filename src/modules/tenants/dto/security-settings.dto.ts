import { IsBoolean, IsInt, IsOptional, Min, Max, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

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
