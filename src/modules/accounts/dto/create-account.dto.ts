import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsUUID } from 'class-validator';
import { AccountType } from '@prisma/client';

export class CreateAccountDto {
  @ApiProperty({ description: 'Member ID to open the account for' })
  @IsUUID()
  memberId!: string;

  @ApiProperty({ enum: AccountType, description: 'BOSA = savings, FOSA = transactional banking' })
  @IsEnum(AccountType)
  accountType!: AccountType;
}
