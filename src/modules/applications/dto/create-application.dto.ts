import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  Matches,
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
 * The caller supplies a stageId (chosen from the registered stage list).
 * The service resolves wardId and stageName from that record so the caller
 * never has to send a redundant location cascade.
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

  @ApiProperty({
    description: 'ID of the registered boda boda stage (cuid). wardId and stageName are derived server-side.',
  })
  @IsString()
  @IsNotEmpty()
  stageId!: string;

  @ApiPropertyOptional({
    enum: ApplicationPosition,
    default: ApplicationPosition.MEMBER,
    description: 'Position at the stage',
  })
  @IsOptional()
  @IsEnum(ApplicationPosition)
  position?: ApplicationPosition;

  @ApiPropertyOptional({
    description: 'MinIO pre-signed URL for the uploaded KYC form scan',
  })
  @IsOptional()
  @IsString()
  documentUrl?: string;
}
