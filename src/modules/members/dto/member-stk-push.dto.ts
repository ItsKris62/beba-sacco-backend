import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, Matches, Min } from 'class-validator';

export class MemberStkPushDto {
  @ApiProperty({ example: '254712345678', description: 'Phone number in format 254XXXXXXXXX' })
  @IsString()
  @Matches(/^254[0-9]{9}$/, { message: 'Phone must be in 254XXXXXXXXX format' })
  phone!: string;

  @ApiProperty({ example: 500, description: 'Amount in KES as a decimal-safe string at the API boundary. Prefer decimal-safe string formatting at the API boundary.' })
  @IsNumber()
  @Min(10, { message: 'Minimum deposit amount is KES 10' })
  amount!: number;
}

