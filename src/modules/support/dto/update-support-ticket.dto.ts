import { ApiPropertyOptional } from '@nestjs/swagger';
import { TicketPriority, TicketStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class UpdateSupportTicketDto {
  @ApiPropertyOptional({ enum: TicketStatus, example: TicketStatus.WAITING_ON_MEMBER })
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @ApiPropertyOptional({ enum: TicketPriority, example: TicketPriority.HIGH })
  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @ApiPropertyOptional({ description: 'Admin/manager user UUID', example: '1e9ebff1-f9f9-4f52-a2a6-1c117c71b4f2' })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @ApiPropertyOptional({ example: 'Escalated to loans team.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({ example: 'Issue resolved after confirming repayment allocation.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolutionNote?: string;
}




