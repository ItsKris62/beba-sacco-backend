import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsPhoneNumber, Min } from 'class-validator';

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
    required: false,
    description:
      'Deprecated compatibility field. The server resolves the payout destination from the member verified phone and rejects mismatches.',
  })
  @IsOptional()
  @IsPhoneNumber('KE', { message: 'Must be a valid Kenyan phone number' })
  phoneNumber?: string;
}
