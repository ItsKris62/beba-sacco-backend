import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TicketCategory, TicketPriority } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateSupportTicketDto {
  @ApiProperty({ example: 'Loan repayment not reflected' })
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  subject!: string;

  @ApiProperty({ example: 'I made a repayment yesterday but my loan balance has not changed.' })
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  description!: string;

  @ApiPropertyOptional({ enum: TicketPriority, default: TicketPriority.MEDIUM, example: TicketPriority.MEDIUM })
  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @ApiPropertyOptional({ enum: TicketCategory, default: TicketCategory.GENERAL, example: TicketCategory.LOAN_QUERY })
  @IsOptional()
  @IsEnum(TicketCategory)
  category?: TicketCategory;

  @ApiPropertyOptional({ description: 'Related loan UUID', example: '9b29f4b9-41a5-4ef6-8440-8e5d05f2ef51' })
  @IsOptional()
  @IsUUID()
  relatedLoanId?: string;

  @ApiPropertyOptional({ description: 'Related ledger transaction UUID', example: '2f9b2f3f-2af3-4504-a9ef-f6ec9e0c1ad7' })
  @IsOptional()
  @IsUUID()
  relatedTxId?: string;
}


