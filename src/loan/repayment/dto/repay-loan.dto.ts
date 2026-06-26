import { ApiProperty } from '@nestjs/swagger';
import { IsNumberString } from 'class-validator';

export class RepayLoanDto {
  @ApiProperty({ example: '2500.00' })
  @IsNumberString()
  amount!: string;
}

