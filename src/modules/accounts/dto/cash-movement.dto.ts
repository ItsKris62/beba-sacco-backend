import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsAlphanumeric, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

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

  @ApiPropertyOptional({
    description:
      'Client-supplied idempotency key. Retrying the same request with the same key ' +
      'replays the original result instead of posting a second time. If omitted, a ' +
      'deterministic key is derived from (tenant, account, amount, minute) — so an ' +
      'automatic client retry within the same minute is still deduplicated.',
    example: 'a1b2c3d4-teller-terminal-7',
  })
  @IsOptional()
  @IsString()
  @IsAlphanumeric(undefined, { message: 'idempotencyKey must be alphanumeric' })
  @MaxLength(100)
  idempotencyKey?: string;
}
