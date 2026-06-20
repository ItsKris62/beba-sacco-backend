import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class LedgerQueryDto {
  @ApiPropertyOptional({ description: 'Page number', example: 1, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Rows per page',
    example: 20,
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Start date (inclusive) — ISO 8601 date',
    example: '2026-01-01',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'End date (inclusive) — ISO 8601 date',
    example: '2026-05-31',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Filter to a single account UUID' })
  @IsOptional()
  @IsUUID()
  accountId?: string;
}

export class ReconQueryDto {
  @ApiPropertyOptional({
    description: 'Settlement date — ISO 8601 date. Defaults to today.',
    example: '2026-05-08',
  })
  @IsOptional()
  @IsDateString()
  date?: string;
}

export class ReportsQueryDto {
  @ApiPropertyOptional({ description: 'Report period start (inclusive)', example: '2026-01-01' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Report period end (inclusive)', example: '2026-05-31' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class GetPendingReconQueryDto {
  @ApiPropertyOptional({ description: 'Page number', example: 1, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Rows per page',
    example: 20,
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Created-at start date (inclusive)', example: '2026-05-01' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Alias for startDate', example: '2026-05-01' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Created-at end date (inclusive)', example: '2026-05-08' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Alias for endDate', example: '2026-05-08' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ description: 'M-Pesa rail', enum: ['STK', 'B2C'], example: 'STK' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(['STK', 'B2C'])
  type?: 'STK' | 'B2C';

  @ApiPropertyOptional({ description: 'Search receipt, checkout id, phone, or account reference' })
  @IsOptional()
  @IsString()
  search?: string;
}
