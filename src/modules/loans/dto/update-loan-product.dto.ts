import { PartialType } from '@nestjs/swagger';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateLoanProductDto } from './create-loan-product.dto';

export class UpdateLoanProductDto extends PartialType(CreateLoanProductDto) {
  @ApiPropertyOptional({ example: true, description: 'Whether members can select this product' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
