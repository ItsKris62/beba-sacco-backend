import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RejectLoanDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  reason!: string;
}
