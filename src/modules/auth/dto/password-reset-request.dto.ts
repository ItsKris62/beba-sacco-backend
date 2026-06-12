import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsString,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

export enum PasswordResetMethod {
  EMAIL = 'EMAIL',
  SMS = 'SMS',
}

@ValidatorConstraint({ name: 'PasswordResetIdentifier', async: false })
class PasswordResetIdentifierConstraint implements ValidatorConstraintInterface {
  validate(identifier: unknown, args: ValidationArguments): boolean {
    const dto = args.object as PasswordResetRequestDto;
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
    const dto = args.object as PasswordResetRequestDto;
    return dto.method === PasswordResetMethod.SMS
      ? 'identifier must be a valid E.164 Kenyan phone number'
      : 'identifier must be a valid email address';
  }
}

export class PasswordResetRequestDto {
  @ApiProperty({
    enum: PasswordResetMethod,
    description: 'Delivery channel for the password reset OTP',
    example: PasswordResetMethod.SMS,
  })
  @IsEnum(PasswordResetMethod)
  method!: PasswordResetMethod;

  @ApiProperty({
    description: 'Registered email address or E.164 Kenyan phone number',
    examples: ['member@example.com', '+254712345678'],
  })
  @IsString()
  @Validate(PasswordResetIdentifierConstraint)
  identifier!: string;
}
