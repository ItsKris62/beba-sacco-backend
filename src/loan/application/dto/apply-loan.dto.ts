import { ApiProperty } from '@nestjs/swagger';
import { IsDecimal, IsString, IsUUID, MinLength } from 'class-validator';

export class ApplyLoanDto {
  @ApiProperty()
  @IsUUID()
  loanProductId!: string;

  @ApiProperty({ example: '50000.00' })
  @IsString()
  @IsDecimal({ decimal_digits: '0,4' })
  amount!: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  purpose!: string;
}

