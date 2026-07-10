import { ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationChannel, NotificationStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const NOTIFICATION_LOG_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'eventType',
  'status',
  'channel',
] as const;

export type NotificationLogSortField = (typeof NOTIFICATION_LOG_SORT_FIELDS)[number];

export class GetNotificationLogsDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ enum: NotificationStatus })
  @IsOptional()
  @IsEnum(NotificationStatus)
  status?: NotificationStatus;

  @ApiPropertyOptional({ enum: NotificationChannel })
  @IsOptional()
  @IsEnum(NotificationChannel)
  channel?: NotificationChannel;

  @ApiPropertyOptional({ description: 'Filter by domain event name, e.g. loan.approved' })
  @IsOptional()
  @IsString()
  eventType?: string;

  @ApiPropertyOptional({ description: 'Partial recipient search' })
  @IsOptional()
  @IsString()
  recipient?: string;

  @ApiPropertyOptional({ enum: NOTIFICATION_LOG_SORT_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(NOTIFICATION_LOG_SORT_FIELDS)
  sortBy?: NotificationLogSortField;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}
