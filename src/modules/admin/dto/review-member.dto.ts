import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsString, ValidateIf } from 'class-validator';

export enum ReviewAction {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class ReviewMemberDto {
  @ApiProperty({
    enum: ReviewAction,
    description: 'APPROVE clears KYC and opens FOSA + BOSA accounts. REJECT requires a reason.',
    example: ReviewAction.APPROVE,
  })
  @IsEnum(ReviewAction)
  action!: ReviewAction;

  @ApiPropertyOptional({
    description: 'Required when action = REJECT. Stored on the member record and sent to the member via email.',
    example: 'National ID photo is too blurry — please re-upload a clear copy.',
  })
  @ValidateIf((o: ReviewMemberDto) => o.action === ReviewAction.REJECT)
  @IsString()
  reason?: string;
}
