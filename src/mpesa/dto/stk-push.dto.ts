import { ApiProperty } from '@nestjs/swagger';
import { IsDecimal, IsString } from 'class-validator';

export class StkPushDto {
  @ApiProperty({ example: '1000.00' })
  @IsString()
  @IsDecimal({ decimal_digits: '0,4' })
  amount!: string;
}

