import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsISO8601 } from 'class-validator';

export enum GenerateReportType {
  LOAN_BOOK = 'LOAN_BOOK',
  MEMBER_BALANCES = 'MEMBER_BALANCES',
  AUDIT_TRAIL = 'AUDIT_TRAIL',
  EXECUTIVE = 'EXECUTIVE',
}

export enum GenerateReportFormat {
  CSV = 'CSV',
  PDF = 'PDF',
}

export class GenerateReportDto {
  @ApiProperty({ enum: GenerateReportType })
  @IsEnum(GenerateReportType)
  type!: GenerateReportType;

  @ApiProperty({ enum: GenerateReportFormat })
  @IsEnum(GenerateReportFormat)
  format!: GenerateReportFormat;

  @ApiProperty({ example: '2026-05-01T00:00:00.000Z' })
  @IsISO8601()
  from!: string;

  @ApiProperty({ example: '2026-05-31T23:59:59.999Z' })
  @IsISO8601()
  to!: string;
}
