import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsString,
  Matches,
  MinLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { PasswordResetMethod } from './password-reset-request.dto';

@ValidatorConstraint({ name: 'PasswordResetVerifyIdentifier', async: false })
class PasswordResetVerifyIdentifierConstraint implements ValidatorConstraintInterface {
  validate(identifier: unknown, args: ValidationArguments): boolean {
    const dto = args.object as PasswordResetVerifyDto;
    if (typeof identifier !== 'string') {
      return false;
    }

    if (dto.method === PasswordResetMethod.EMAIL) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
    }

    if (dto.method === PasswordResetMethod.SMS) {
      return /^\+254[17]\d{8}$/.test(identifier);
    }

    return false;
  }

  defaultMessage(args: ValidationArguments): string {
    const dto = args.object as PasswordResetVerifyDto;
    return dto.method === PasswordResetMethod.SMS
      ? 'identifier must be a valid E.164 Kenyan phone number'
      : 'identifier must be a valid email address';
  }
}

export class PasswordResetVerifyDto {
  @ApiProperty({
    enum: PasswordResetMethod,
    description: 'Delivery channel used for the password reset OTP',
    example: PasswordResetMethod.SMS,
  })
  @IsEnum(PasswordResetMethod)
  method!: PasswordResetMethod;

  @ApiProperty({
    description: 'Registered email address or E.164 Kenyan phone number',
    examples: ['member@example.com', '+254712345678'],
  })
  @IsString()
  @Validate(PasswordResetVerifyIdentifierConstraint)
  identifier!: string;

  @ApiProperty({
    description: '6-digit OTP received via email or SMS',
    example: '123456',
  })
  @Matches(/^\d{6}$/, { message: 'otp must be exactly 6 digits' })
  otp!: string;

  @ApiProperty({
    description:
      'New password. Min 8 chars, must include uppercase, lowercase, digit, and special character.',
    example: 'NewSecure@2026!',
  })
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  newPassword!: string;
}
