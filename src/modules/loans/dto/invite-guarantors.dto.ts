import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray, IsNumber, IsUUID, Min, ArrayMinSize, ArrayMaxSize, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class GuarantorItemDto {
  @ApiProperty({ description: 'Member ID of the guarantor' })
  @IsUUID()
  memberId!: string;

  @ApiProperty({ description: 'Amount this guarantor is covering (KES)', example: 20000 })
  @IsNumber()
  @Min(1)
  guaranteedAmount!: number;
}

export class InviteGuarantorsDto {
  @ApiProperty({
    type: [GuarantorItemDto],
    description: 'List of guarantors to invite. Minimum 3 required.',
  })
  @IsArray()
  @ArrayMinSize(3, { message: 'At least 3 guarantors are required' })
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => GuarantorItemDto)
  guarantors!: GuarantorItemDto[];
}
