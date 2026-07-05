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
    example: '123456',
    description: '4-6 digit temporary PIN received via SMS',
  })
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'pin must be 4 to 6 digits' })
  pin!: string;
}
