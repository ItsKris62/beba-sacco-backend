import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { JournalEntryStatus, JournalEntryType } from '@prisma/client';

export class JournalEntryQueryDto {
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

  @ApiPropertyOptional({ description: 'Filter by entry status', enum: JournalEntryStatus })
  @IsOptional()
  @IsEnum(JournalEntryStatus)
  status?: JournalEntryStatus;

  @ApiPropertyOptional({ description: 'Filter by entry type', enum: JournalEntryType })
  @IsOptional()
  @IsEnum(JournalEntryType)
  type?: JournalEntryType;

  @ApiPropertyOptional({ description: 'Start date (inclusive)', example: '2026-01-01' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date (inclusive)', example: '2026-12-31' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    description: 'Search term (matches entry number, description)',
    example: 'JE-2026',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;
}
