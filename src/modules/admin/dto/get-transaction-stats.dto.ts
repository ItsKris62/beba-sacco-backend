import { IsISO8601, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class GetTransactionStatsQueryDto {
  @ApiPropertyOptional({ description: 'ISO 8601 start date (inclusive)', example: '2026-01-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO 8601 end date (inclusive)', example: '2026-12-31T23:59:59Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Search by reference or account number' })
  @IsOptional()
  @IsString()
  search?: string;
}

export class TransactionStatsResponseDto {
  @ApiProperty({ example: 125000 })
  pageVolume!: number;

  @ApiProperty({ example: 85000 })
  inflows!: number;

  @ApiProperty({ example: 40000 })
  outflows!: number;

  @ApiProperty({ example: 45000 })
  netFlow!: number;

  @ApiProperty({ nullable: true, example: '2026-01-01T00:00:00.000Z' })
  periodStart!: string | null;

  @ApiProperty({ nullable: true, example: '2026-12-31T23:59:59.000Z' })
  periodEnd!: string | null;
}
