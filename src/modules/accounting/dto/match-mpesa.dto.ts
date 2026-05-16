import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class MatchMpesaTransactionDto {
  @ApiProperty({
    description: 'UUID of the account to credit the deposit to',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @IsUUID()
  @IsNotEmpty()
  accountId!: string;

  @ApiPropertyOptional({
    description: 'Admin note explaining the reconciliation decision (max 500 chars)',
    example: 'Member called in — confirmed payment via phone records',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
