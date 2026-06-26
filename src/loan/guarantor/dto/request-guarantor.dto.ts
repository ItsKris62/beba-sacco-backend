import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class RequestGuarantorDto {
  @ApiProperty()
  @IsUUID()
  targetMemberId!: string;
}
