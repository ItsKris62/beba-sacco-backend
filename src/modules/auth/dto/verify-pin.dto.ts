import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class VerifyPinDto {
  @ApiProperty({
    example: '+254712345678',
    description: 'Phone number the temporary PIN was sent to',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, { message: 'Provide a valid phone number' })
  phone!: string;

  @ApiProperty({
    example: 'Kx7@mPq2',
    description: '8-character temporary access code received via SMS (letters, digits, and symbols)',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^[A-Za-z0-9@#$!]{8}$/, { message: 'code must be exactly 8 characters' })
  pin!: string;
}
