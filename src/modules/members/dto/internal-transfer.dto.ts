import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNumber, IsOptional, IsString, MaxLength, Min, Validate, ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments } from 'class-validator';
import { AccountType } from '@prisma/client';

@ValidatorConstraint({ name: 'differentAccountTypes', async: false })
class DifferentAccountTypesConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as InternalTransferDto;
    return obj.fromAccountType !== obj.toAccountType;
  }

  defaultMessage(): string {
    return 'fromAccountType and toAccountType must be different';
  }
}

export class InternalTransferDto {
  @ApiProperty({
    enum: AccountType,
    description: 'Source account type (FOSA or BOSA)',
    example: 'FOSA',
  })
  @IsEnum(AccountType)
  fromAccountType!: AccountType;

  @ApiProperty({
    enum: AccountType,
    description: 'Destination account type (must be different from source)',
    example: 'BOSA',
  })
  @IsEnum(AccountType)
  @Validate(DifferentAccountTypesConstraint)
  toAccountType!: AccountType;

  @ApiProperty({
    description: 'Amount in KES (minimum KES 100)',
    example: 5000,
  })
  @IsNumber()
  @Min(100, { message: 'Minimum transfer amount is KES 100' })
  amount!: number;

  @ApiPropertyOptional({
    description: 'Optional narration for the transfer',
    example: 'Moving savings to BOSA',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  narration?: string;
}
