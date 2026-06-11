import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class PasswordResetRequestDto {
  @ApiProperty({
    description: 'Last 5 digits of the registered phone number',
    example: '45678',
  })
  @Matches(/^\d{5}$/, { message: 'lastFiveDigits must be exactly 5 digits' })
  lastFiveDigits!: string;
}
