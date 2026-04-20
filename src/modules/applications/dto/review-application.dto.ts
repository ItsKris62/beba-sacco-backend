import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApproveApplicationDto {
  @ApiPropertyOptional({ description: 'Optional email for the new user account' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({ description: 'Temporary password for the new account (auto-generated if omitted)' })
  @IsOptional()
  @IsString()
  temporaryPassword?: string;

  @ApiPropertyOptional({ description: 'Reviewer notes' })
  @IsOptional()
  @IsString()
  reviewNotes?: string;
}

export class RejectApplicationDto {
  @ApiProperty({ description: 'Reason for rejection (stored on the application record)' })
  @IsString()
  @IsNotEmpty()
  reviewNotes!: string;
}
