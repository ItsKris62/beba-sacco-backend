import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, Min, Matches } from 'class-validator';

export class StkPushDto {
  @ApiProperty({ example: '254712345678', description: 'Phone in format 254XXXXXXXXX' })
  @IsString()
  @Matches(/^254[0-9]{9}$/, { message: 'Invalid Kenyan phone number format' })
  phoneNumber!: string;

  @ApiProperty({ example: 1000, description: 'Amount in KES' })
  @IsNumber()
  @Min(1)
  amount!: number;

  @ApiProperty({ example: 'LOAN_REPAYMENT_12345', description: 'Transaction reference' })
  @IsString()
  reference!: string;

  @ApiProperty({ example: 'ACC_67890', description: 'Account reference' })
  @IsString()
  accountReference!: string;
}
