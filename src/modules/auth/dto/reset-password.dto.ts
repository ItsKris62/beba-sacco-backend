import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    description: 'The signed reset token received via email',
  })
  @IsString()
  token!: string;

  @ApiProperty({
    description:
      'New password. Min 8 chars, must include uppercase, lowercase, digit, and special character.',
    example: 'NewSecure@2025!',
  })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])/, {
    message:
      'Password must contain at least one uppercase letter, one lowercase letter, one digit, and one special character',
  })
  newPassword!: string;
}
