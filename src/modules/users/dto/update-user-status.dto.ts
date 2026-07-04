import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { AccountStatus } from '@prisma/client';

/**
 * DTO for PATCH /users/:id/status
 * Explicit approval workflow state machine.
 */
export class UpdateUserStatusDto {
  @ApiProperty({ enum: AccountStatus, description: 'New status to assign' })
  @IsEnum(AccountStatus)
  status!: AccountStatus;

  @ApiPropertyOptional({ description: 'Reason for rejection or contextual notes' })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({ description: 'Idempotency key for this status change' })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
