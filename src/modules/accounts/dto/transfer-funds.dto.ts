import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class TransferFundsDto {
  @ApiProperty({ description: 'Destination account UUID (must belong to the same member)' })
  @IsUUID()
  destinationAccountId!: string;

  @ApiProperty({ description: 'Amount in KES (must be positive)', example: 5000 })
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional({ description: 'Optional narrative for the transfer' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
