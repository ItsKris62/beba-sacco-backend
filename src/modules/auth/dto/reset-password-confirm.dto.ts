import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  Matches,
  MinLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Transform } from 'class-transformer';

@ValidatorConstraint({ name: 'MatchesResetNewPassword', async: false })
class MatchesResetNewPasswordConstraint implements ValidatorConstraintInterface {
  validate(confirmPassword: unknown, args: ValidationArguments): boolean {
    const dto = args.object as ResetPasswordConfirmDto;
    return typeof confirmPassword === 'string' && confirmPassword === dto.newPassword;
  }

  defaultMessage(): string {
    return 'confirmPassword must match newPassword';
  }
}

export class ResetPasswordConfirmDto {
  @ApiProperty({ example: '+254712345678' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, { message: 'Provide a valid phone number' })
  phone!: string;

  @ApiProperty({ example: '123456', description: '4-6 digit PIN received via SMS' })
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'pin must be 4 to 6 digits' })
  pin!: string;

  @ApiProperty({
    description:
      'New password. Min 8 chars, must include uppercase, lowercase, digit, and special character.',
    example: 'NewSecure@2025',
  })
  @IsString()
  @MinLength(8)
  newPassword!: string;

  @ApiProperty({ description: 'Must match newPassword', example: 'NewSecure@2025' })
  @IsString()
  @Validate(MatchesResetNewPasswordConstraint)
  confirmPassword!: string;
}
