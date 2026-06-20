import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JournalEntryType } from '@prisma/client';

export class GLPostingLineDto {
  @ApiProperty({
    description: 'GL account UUID for the debit side',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @IsUUID()
  @IsNotEmpty()
  debitAccountId!: string;

  @ApiProperty({
    description: 'GL account UUID for the credit side',
    example: 'f6e5d4c3-b2a1-0987-6543-210fedcba098',
  })
  @IsUUID()
  @IsNotEmpty()
  creditAccountId!: string;

  @ApiProperty({
    description: 'Posting amount in KES (must be positive)',
    example: 25000,
  })
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional({
    description: 'Line-level description',
    example: 'Savings deposit allocation',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class CreateJournalEntryDto {
  @ApiProperty({
    description: 'Narrative description of the journal entry',
    example: 'Member savings deposit - John Kamau',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  description!: string;

  @ApiProperty({
    description: 'Type of journal entry',
    enum: JournalEntryType,
    example: 'MANUAL',
  })
  @IsEnum(JournalEntryType)
  type!: JournalEntryType;

  @ApiProperty({
    description: 'One or more debit/credit posting lines. Sum of debits must equal sum of credits.',
    type: [GLPostingLineDto],
    minItems: 1,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GLPostingLineDto)
  postings!: GLPostingLineDto[];

  @ApiPropertyOptional({
    description: 'Reference entity type (e.g., "LOAN", "MPESA_TRANSACTION")',
    example: 'MPESA_TRANSACTION',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  referenceType?: string;

  @ApiPropertyOptional({
    description: 'UUID of the referenced entity',
    example: 'b2c3d4e5-f6a7-8901-bcde-f23456789012',
  })
  @IsOptional()
  @IsUUID()
  referenceId?: string;
}
