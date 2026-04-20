import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  Matches,
  Length,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum ApplicationPosition {
  CHAIRMAN = 'CHAIRMAN',
  SECRETARY = 'SECRETARY',
  TREASURER = 'TREASURER',
  MEMBER = 'MEMBER',
}

/**
 * DTO for submitting a new member application form.
 *
 * Validation rules (enforced at DTO + DB levels):
 *  - idNumber: Kenyan National ID – exactly 7 or 8 digits
 *  - phoneNumber: Kenyan mobile – 07xxxxxxxx or 2547xxxxxxxx
 *  - wardId: must reference a valid Ward in the scoped location hierarchy
 *
 * NOTE: Self-registration is NOT allowed. This form is submitted by staff
 * on behalf of a prospective member (physical/digital form intake).
 */
export class CreateApplicationDto {
  @ApiProperty({ example: 'John', description: 'First name of the applicant' })
  @IsString()
  @IsNotEmpty()
  firstName!: string;

  @ApiProperty({ example: 'Doe', description: 'Last name of the applicant' })
  @IsString()
  @IsNotEmpty()
  lastName!: string;

  @ApiProperty({
    example: '12345678',
    description: 'Kenyan National ID number (7–8 digits)',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{7,8}$/, {
    message: 'idNumber must be a 7 or 8 digit Kenyan National ID number',
  })
  idNumber!: string;

  @ApiProperty({
    example: '0712345678',
    description: 'Kenyan phone number (07xxxxxxxxx or 2547xxxxxxxxx)',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^(254|0)\d{9}$/, {
    message: 'phoneNumber must be a valid Kenyan phone number (07xxxxxxxxx or 2547xxxxxxxxx)',
  })
  phoneNumber!: string;

  @ApiProperty({ example: 'Westlands Stage', description: 'Name of the boda boda stage' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 100)
  stageName!: string;

  @ApiPropertyOptional({
    enum: ApplicationPosition,
    default: ApplicationPosition.MEMBER,
    description: 'Position at the stage',
  })
  @IsOptional()
  @IsEnum(ApplicationPosition)
  position?: ApplicationPosition;

  @ApiProperty({ description: 'Ward ID (cuid) from the location hierarchy' })
  @IsString()
  @IsNotEmpty()
  wardId!: string;

  @ApiPropertyOptional({
    description: 'MinIO pre-signed URL for the uploaded KYC form scan',
  })
  @IsOptional()
  @IsString()
  documentUrl?: string;
}
