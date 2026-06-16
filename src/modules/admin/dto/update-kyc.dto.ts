import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  ACCEPTED_KYC_STATUS_VALUES,
  BUSINESS_KYC_STATUS_VALUES,
  type BusinessKycStatus,
} from '../../members/member.types';

export class UpdateKycDto {
  @ApiPropertyOptional({ description: 'National ID number', example: '12345678' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  nationalId?: string;

  @ApiPropertyOptional({ description: 'KRA PIN', example: 'A001234567B' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  kraPin?: string;

  @ApiPropertyOptional({ example: '254712345678' })
  @IsOptional()
  @IsString()
  @Matches(/^254[0-9]{9}$/, { message: 'Phone must be 254XXXXXXXXX format' })
  phone?: string;

  @ApiPropertyOptional({ example: '254712345679', description: 'Next-of-kin phone number' })
  @IsOptional()
  @IsString()
  @Matches(/^254[0-9]{9}$/, { message: 'Next-of-kin phone must be 254XXXXXXXXX format' })
  nextOfKinPhone?: string;

  @ApiPropertyOptional({ description: 'Physical address' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @ApiPropertyOptional({ description: 'Employer name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  employer?: string;

  @ApiPropertyOptional({ description: 'Occupation / job title' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  occupation?: string;

  @ApiPropertyOptional({ description: 'Date of birth (ISO 8601)', example: '1990-01-15' })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({
    description: 'Target stage ID. Preferred when the admin is moving the member to a specific existing stage.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  stageId?: string;

  @ApiPropertyOptional({
    description: 'Target stage name. Used when stageId is not supplied; resolved within the member ward.',
    example: 'ACTIVE',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  stageName?: string;

  @ApiPropertyOptional({
    description: 'Approved KYC document IDs reviewed by staff. Required when verified=true.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  documentIds?: string[];

  @ApiPropertyOptional({
    description:
      'Final KYC decision. true approves, false rejects with notes, omitted updates profile fields only.',
  })
  @IsOptional()
  @IsBoolean()
  verified?: boolean;

  @ApiPropertyOptional({
    enum: ACCEPTED_KYC_STATUS_VALUES,
    description:
      'Optional KYC status. When FEATURE_KYC_STATUS_ALIAS=true, accepts internal enums or business aliases.',
  })
  @IsOptional()
  @IsString()
  @IsIn(ACCEPTED_KYC_STATUS_VALUES)
  status?: string;

  @ApiPropertyOptional({
    enum: BUSINESS_KYC_STATUS_VALUES,
    description: 'Business-facing status alias, for example VERIFIED or UNDER_REVIEW.',
  })
  @IsOptional()
  @IsString()
  @IsIn(BUSINESS_KYC_STATUS_VALUES)
  statusAlias?: BusinessKycStatus;

  @ApiPropertyOptional({ description: 'Reviewer notes or rejection reason', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({
    description:
      'Boolean checklist of required KYC controls, for example idDocument, phoneVerified, memberFormSigned.',
    example: { idDocument: true, phoneVerified: true, memberFormSigned: true },
  })
  @IsOptional()
  @IsObject()
  checklist?: Record<string, boolean>;
}
