import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsPhoneNumber, Min } from 'class-validator';

export class WithdrawMpesaDto {
  @ApiProperty({
    example: 1000,
    description: 'Amount to withdraw to M-Pesa',
  })
  @IsNumber()
  @Min(10, { message: 'Minimum withdrawal amount is 10 KES' })
  amount!: number;

  @ApiProperty({
    example: '254700000000',
    description: 'Valid Kenyan M-Pesa phone number (E.164 format or local 07xx/01xx)',
  })
  @IsNotEmpty()
  @IsPhoneNumber('KE', { message: 'Must be a valid Kenyan phone number' })
  phoneNumber!: string;
}

