import { ApiProperty } from '@nestjs/swagger';
import { Matches, MinLength } from 'class-validator';

export class PasswordResetVerifyDto {
  @ApiProperty({
    description: 'Last 5 digits of the registered phone number',
    example: '45678',
  })
  @Matches(/^\d{5}$/, { message: 'lastFiveDigits must be exactly 5 digits' })
  lastFiveDigits!: string;

  @ApiProperty({
    description: '6-digit OTP received via SMS',
    example: '123456',
  })
  @Matches(/^\d{6}$/, { message: 'otp must be exactly 6 digits' })
  otp!: string;

  @ApiProperty({
    description:
      'New password. Min 8 chars, must include uppercase, lowercase, digit, and special character.',
    example: 'NewSecure@2025!',
  })
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])/, {
    message:
      'Password must contain at least one uppercase letter, one lowercase letter, one digit, and one special character',
  })
  newPassword!: string;
}
