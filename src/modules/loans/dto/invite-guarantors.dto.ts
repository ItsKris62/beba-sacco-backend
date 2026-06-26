import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray, IsNumber, IsUUID, Min, ArrayMinSize, ArrayMaxSize, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class GuarantorItemDto {
  @ApiProperty({ description: 'Member ID of the guarantor' })
  @IsUUID()
  memberId!: string;

  @ApiProperty({ description: 'Amount this guarantor is covering in KES as a decimal-safe string at the API boundary', example: 20000 })
  @IsNumber()
  @Min(1)
  guaranteedAmount!: number;
}

export class InviteGuarantorsDto {
  @ApiProperty({
    type: [GuarantorItemDto],
    description: 'List of guarantors to invite. Product rules may require 1-3 guarantors; MVP hard cap is 3.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'At least 1 guarantor is required' })
  @ArrayMaxSize(3, { message: 'At most 3 guarantors are allowed' })
  @ValidateNested({ each: true })
  @Type(() => GuarantorItemDto)
  guarantors!: GuarantorItemDto[];
}

