import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class ResendLoginOtpDto {
  @ApiProperty({
    example: '+254712345678',
    description: 'Phone number to resend the verification code to',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, { message: 'Provide a valid phone number' })
  phone!: string;
}
