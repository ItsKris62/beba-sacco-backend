import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsDateString, IsObject, IsOptional, IsString, IsUrl, Matches, MaxLength } from 'class-validator';

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
    description: 'KYC document URLs reviewed by staff. Required when verified=true.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  documentUrls?: string[];

  @ApiPropertyOptional({
    description: 'Final KYC decision. true approves, false rejects with notes, omitted updates profile fields only.',
  })
  @IsOptional()
  @IsBoolean()
  verified?: boolean;

  @ApiPropertyOptional({ description: 'Reviewer notes or rejection reason', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({
    description: 'Boolean checklist of required KYC controls, for example idDocument, phoneVerified, memberFormSigned.',
    example: { idDocument: true, phoneVerified: true, memberFormSigned: true },
  })
  @IsOptional()
  @IsObject()
  checklist?: Record<string, boolean>;
}
