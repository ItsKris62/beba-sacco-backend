import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsUUID, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';
import { LoanStatus } from '@prisma/client';

export class GetAdminLoansQueryDto {
  @ApiPropertyOptional({ enum: LoanStatus, description: 'Filter by loan status' })
  @IsOptional()
  @IsEnum(LoanStatus)
  status?: LoanStatus;

  @ApiPropertyOptional({ description: 'Filter by loan product UUID' })
  @IsOptional()
  @IsUUID()
  loanProductId?: string;

  @ApiPropertyOptional({ description: 'Filter by member UUID' })
  @IsOptional()
  @IsUUID()
  memberId?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1, type: Number })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100, type: Number })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
