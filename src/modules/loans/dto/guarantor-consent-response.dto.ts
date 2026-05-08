import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Guarantor action enum — explicit consent actions.
 */
export enum GuarantorConsentAction {
  ACCEPT = 'ACCEPT',
  REJECT = 'REJECT',
}

/**
 * DTO for guarantor consent response.
 * The guarantor must explicitly accept or decline with a digital acknowledgment.
 */
export class GuarantorConsentResponseDto {
  @ApiProperty({
    enum: GuarantorConsentAction,
    description: 'Explicit action: ACCEPT or REJECT the guarantee request',
    example: 'ACCEPT',
  })
  @IsEnum(GuarantorConsentAction)
  action!: GuarantorConsentAction;

  @ApiProperty({
    description: 'Digital acknowledgment — must be true to confirm explicit consent',
    example: true,
  })
  @IsBoolean()
  digitalAcknowledgment!: boolean;

  @ApiPropertyOptional({
    description: 'Optional reason or note, especially when rejecting',
    example: 'I am already guaranteeing two other loans',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
