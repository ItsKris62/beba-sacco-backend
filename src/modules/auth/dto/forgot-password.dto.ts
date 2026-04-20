import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({
    description: 'Email address of the account to reset',
    example: 'user@example.com',
  })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email!: string;
}
