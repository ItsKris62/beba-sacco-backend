import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class SignApprovalChainDto {
  @ApiProperty({
    description: 'true to approve this dual-control sign-off slot, false to reject it',
    example: true,
  })
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional({
    description: 'Optional notes, especially when rejecting',
    example: 'Confirmed with member by phone',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
