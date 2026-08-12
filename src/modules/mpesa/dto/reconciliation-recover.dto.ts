import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ManualReconciliationEvidenceDto {
  @ApiProperty({
    description: 'Operational reason for the manual reconciliation action.',
    example: 'Confirmed with Mwaloni support that the provider status endpoint is unavailable.',
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;

  @ApiProperty({
    description: 'External provider/support/reference evidence supporting the action.',
    example: 'MWALONI-SR-88213',
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  evidenceReference!: string;

  @ApiPropertyOptional({
    description:
      'Additional sanitized evidence notes. Do not include secrets or full phone numbers.',
    example:
      'Provider confirmed order MWD-ledger-tx-1 settled successfully at 2026-08-12T08:40:00Z.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  evidenceNote?: string;
}

export class ManualStatusRefreshDto {
  @ApiPropertyOptional({
    description: 'Optional reason for the manual provider-status refresh.',
    example: 'Finance desk requested a fresh status check before closing the case.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class ManualCompletionDto extends ManualReconciliationEvidenceDto {}

export class ManualReversalDto extends ManualReconciliationEvidenceDto {}

export class ControlledResendDto extends ManualReconciliationEvidenceDto {}
