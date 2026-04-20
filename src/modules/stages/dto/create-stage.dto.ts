import { IsString, IsNotEmpty, IsOptional, IsEnum, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum StagePositionDto {
  CHAIRMAN = 'CHAIRMAN',
  SECRETARY = 'SECRETARY',
  TREASURER = 'TREASURER',
  MEMBER = 'MEMBER',
}

export class CreateStageDto {
  @ApiProperty({ example: 'Westlands Stage', description: 'Name of the boda boda stage' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 100)
  name!: string;

  @ApiProperty({ description: 'Ward ID (cuid) where this stage operates' })
  @IsString()
  @IsNotEmpty()
  wardId!: string;
}

export class AssignStagePositionDto {
  @ApiProperty({ description: 'User ID to assign to the stage' })
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @ApiPropertyOptional({
    enum: StagePositionDto,
    default: StagePositionDto.MEMBER,
    description: 'Position at the stage',
  })
  @IsOptional()
  @IsEnum(StagePositionDto)
  position?: StagePositionDto;
}
