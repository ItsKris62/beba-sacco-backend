import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ApproveLoanDto {
  @ApiPropertyOptional({
    description:
      'Optional loan officer review comment. ' +
      'Stored against the loan record and included in the audit trail. ' +
      'Use to note conditions, special terms, or rationale.',
    example: 'Approved subject to salary confirmation slip within 14 days.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Review comment must not exceed 500 characters' })
  comment?: string;
}
