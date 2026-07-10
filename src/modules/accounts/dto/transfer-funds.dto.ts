import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class TransferFundsDto {
  @ApiProperty({ description: 'Destination account UUID (must belong to the same member)' })
  @IsUUID()
  destinationAccountId!: string;

  @ApiProperty({ description: 'Amount in KES (must be positive)', example: 5000 })
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiProperty({
    description: 'Client-generated idempotency key for retry-safe transfer posting',
    example: 'transfer-20260710-member-001',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  idempotencyKey!: string;

  @ApiPropertyOptional({ description: 'Optional narrative for the transfer' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
