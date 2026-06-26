import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

export class RequestGuarantorDto {
  @ApiProperty()
  @IsUUID()
  loanId!: string;

  @ApiProperty()
  @IsUUID()
  guarantorMemberId!: string;
}

export enum GuarantorResponseAction {
  ACCEPT = 'ACCEPT',
  REJECT = 'REJECT',
}

export class RespondToGuarantorRequestDto {
  @ApiProperty({ enum: GuarantorResponseAction })
  @IsEnum(GuarantorResponseAction)
  action!: GuarantorResponseAction;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
