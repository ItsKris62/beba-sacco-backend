import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

export class ExportGLQueryDto {
  @ApiPropertyOptional({ description: 'Export start date (inclusive)', example: '2026-01-01' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Export end date (inclusive)', example: '2026-12-31' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
