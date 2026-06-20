import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ApproveRejectDto {
  @ApiPropertyOptional({
    description: 'Notes explaining the approval or rejection decision (max 1000 chars)',
    example: 'Verified against bank statement – approved for posting',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
