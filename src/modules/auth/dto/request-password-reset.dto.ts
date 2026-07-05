import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class RequestPasswordResetDto {
  @ApiProperty({
    example: '+254712345678',
    description: 'Registered phone number — a password reset PIN is sent via SMS if it matches an account',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, { message: 'Provide a valid phone number' })
  phone!: string;
}
