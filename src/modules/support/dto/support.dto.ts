import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { TicketCategory, TicketPriority } from '@prisma/client';
import { IsArray, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class CreateIncidentDto {
  @ApiProperty() @IsString() @IsNotEmpty() title!: string;
  @ApiProperty() @IsString() @IsNotEmpty() description!: string;
  @ApiProperty() @IsString() @IsNotEmpty() severity!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() affectedService?: string;
}

export class LinkTicketsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  ticketIds!: string[];
}

export class RequestPresignDto {
  @ApiProperty() @IsString() @IsNotEmpty() fileName!: string;
  @ApiProperty() @IsString() @IsNotEmpty() mimeType!: string;
  @ApiProperty({ maximum: 10 * 1024 * 1024 }) @IsInt() @Min(1) @Max(10 * 1024 * 1024) size!: number;
}

export class ConfirmUploadDto {
  @ApiProperty() @IsString() @IsNotEmpty() fileKey!: string;
  @ApiProperty() @IsString() @IsNotEmpty() fileName!: string;
  @ApiProperty() @IsString() @IsNotEmpty() mimeType!: string;
  @ApiProperty({ maximum: 10 * 1024 * 1024 }) @IsInt() @Min(1) @Max(10 * 1024 * 1024) size!: number;
  @ApiProperty({ required: false }) @IsOptional() @IsUUID() messageId?: string;
}

export class SendMessageDto {
  @ApiProperty() @IsString() @IsNotEmpty() content!: string;
  @ApiProperty() @IsString() @IsNotEmpty() messageType!: string;
}

export class ListSupportTicketsDto {
  @ApiProperty({ required: false, description: 'Comma-separated ticket statuses' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiProperty({ required: false, enum: TicketPriority })
  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @ApiProperty({ required: false, enum: TicketCategory })
  @IsOptional()
  @IsEnum(TicketCategory)
  category?: TicketCategory;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false, description: 'Assigned staff user UUID' })
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiProperty({ required: false, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiProperty({ required: false, default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

