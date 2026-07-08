import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class VerifyLoginOtpDto {
  @ApiProperty({
    example: '+254712345678',
    description: 'Phone number the verification code was sent to',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, { message: 'Provide a valid phone number' })
  phone!: string;

  @ApiProperty({
    example: '482913',
    description: '6-digit verification code received via SMS',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Code must be exactly 6 digits' })
  otp!: string;
}
