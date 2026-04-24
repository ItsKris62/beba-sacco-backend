import { IsEnum, IsOptional, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum ExportType {
  LOANS = 'LOANS',
  MEMBERS = 'MEMBERS',
  LIQUIDITY = 'LIQUIDITY',
}

export enum ExportFormat {
  CSV = 'CSV',
  JSON = 'JSON',
}

export class ExportQueryDto {
  @ApiProperty({ enum: ExportType, description: 'Dataset to export' })
  @IsEnum(ExportType)
  type!: ExportType;

  @ApiPropertyOptional({ enum: ExportFormat, default: ExportFormat.CSV })
  @IsOptional()
  @IsEnum(ExportFormat)
  format?: ExportFormat = ExportFormat.CSV;

  @ApiPropertyOptional({ description: 'Start date (ISO 8601)', example: '2025-01-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'End date (ISO 8601)', example: '2025-12-31' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
