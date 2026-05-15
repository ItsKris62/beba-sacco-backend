import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class PatchProfileDto {
  @ApiPropertyOptional({ description: 'Kenyan phone number in E.164 format (+254XXXXXXXXX)' })
  @IsOptional()
  @IsString()
  @Matches(/^\+254\d{9}$/, { message: 'Phone must be a valid Kenyan number (+254XXXXXXXXX)' })
  phone?: string;

  @ApiPropertyOptional({ description: 'Email address' })
  @IsOptional()
  @IsEmail({}, { message: 'Invalid email address' })
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ description: 'Employer name' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  employer?: string;

  @ApiPropertyOptional({ description: 'Occupation or job title' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  occupation?: string;

  @ApiPropertyOptional({
    description: 'Stage UUIDs to assign (admin-only; DB enforces max 5 active per member)',
    type: [String],
  })
  @IsOptional()
  @ArrayMaxSize(5, { message: 'Cannot assign more than 5 stages at once' })
  @IsUUID('4', { each: true, message: 'Each stage ID must be a valid UUID' })
  stageIds?: string[];
}
