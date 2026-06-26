import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

export enum GuarantorResponse {
  ACCEPT = 'ACCEPT',
  REJECT = 'REJECT',
}

export class RespondGuarantorDto {
  @ApiProperty({ enum: GuarantorResponse })
  @IsEnum(GuarantorResponse)
  response!: GuarantorResponse;
}
