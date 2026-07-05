import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  MinLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'MatchesNewPassword', async: false })
class MatchesNewPasswordConstraint implements ValidatorConstraintInterface {
  validate(confirmPassword: unknown, args: ValidationArguments): boolean {
    const dto = args.object as ChangePasswordDto;
    return typeof confirmPassword === 'string' && confirmPassword === dto.newPassword;
  }

  defaultMessage(): string {
    return 'confirmPassword must match newPassword';
  }
}

export class ChangePasswordDto {
  @ApiPropertyOptional({
    description:
      'Current password. Required unless this is the first password set after a ' +
      'PIN-verified onboarding/reset login, in which case the account has no password yet.',
  })
  @IsString()
  @IsOptional()
  currentPassword?: string;

  @ApiProperty({
    description:
      'New password. Min 8 chars, must include uppercase, lowercase, digit, and special character (@$!%*?&).',
    example: 'NewSecure@2025',
  })
  @IsString()
  @MinLength(8)
  newPassword!: string;

  @ApiProperty({ description: 'Must match newPassword', example: 'NewSecure@2025' })
  @IsString()
  @Validate(MatchesNewPasswordConstraint)
  confirmPassword!: string;

  @ApiPropertyOptional({
    description: 'Current access token JTI — sent by frontend to enable immediate revocation',
  })
  @IsString()
  @IsOptional()
  accessTokenJti?: string;
}
