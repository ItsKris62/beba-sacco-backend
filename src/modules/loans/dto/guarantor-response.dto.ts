import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum GuarantorAction {
  ACCEPT = 'ACCEPT',
  DECLINE = 'DECLINE',
}

export class GuarantorResponseDto {
  @ApiProperty({ enum: GuarantorAction, description: 'Accept or decline the guarantor request' })
  @IsEnum(GuarantorAction)
  action!: GuarantorAction;

  @ApiPropertyOptional({ description: 'Optional reason, especially when declining' })
  @IsOptional()
  @IsString()
  notes?: string;
}
