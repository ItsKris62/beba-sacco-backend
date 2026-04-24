import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdatePrivacyDto {
  @ApiProperty({ description: 'Consent to share data with third parties' })
  @IsBoolean()
  consentDataSharing!: boolean;
}
