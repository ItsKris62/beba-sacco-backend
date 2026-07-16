import { IsString, IsNotEmpty, IsOptional, IsEnum, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StagePosition } from '@prisma/client';

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
    description:
      'ID of the registered boda boda stage (cuid). wardId and stageName are derived server-side.',
  })
  @IsString()
  @IsNotEmpty()
  stageId!: string;

  @ApiPropertyOptional({
    description:
      'Ward ID (cuid), used client-side to filter the stage picker. Not authoritative — ' +
      'the server always derives wardId from the resolved stageId and ignores this value ' +
      'if it disagrees, so it is optional and not cross-validated.',
  })
  @IsOptional()
  @IsString()
  wardId?: string;

  @ApiPropertyOptional({
    enum: StagePosition,
    default: StagePosition.MEMBER,
    description: 'Position at the stage — matches the Stage/StageAssignment.position enum.',
  })
  @IsOptional()
  @IsEnum(StagePosition)
  position?: StagePosition;

  @ApiPropertyOptional({
    description: 'MinIO pre-signed URL for the uploaded KYC form scan',
  })
  @IsOptional()
  @IsString()
  documentUrl?: string;
}
