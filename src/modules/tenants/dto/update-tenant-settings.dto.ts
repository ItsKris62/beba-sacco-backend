import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class UpdateTenantSettingsDto {
  @ApiPropertyOptional({
    description: 'Maximum concurrent guarantees a member can have',
    default: 3,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxConcurrentGuarantees?: number;
}
