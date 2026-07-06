import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CashMovementDto {
  @ApiProperty({ description: 'Amount in KES (must be positive)', example: 1000 })
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional({ description: 'Optional narrative for the transaction' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
