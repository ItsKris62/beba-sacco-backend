import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiPropertyOptional({
    description:
      'Refresh token from login or previous refresh. ' +
      'Omit when using HttpOnly cookie — the server reads it automatically.',
  })
  @IsOptional()
  @IsString()
  @MinLength(10)
  refreshToken?: string;
}

export class RefreshTokenResponseDto {
  @ApiProperty({ description: 'New JWT access token (15 min)' })
  accessToken!: string;

  @ApiProperty({ description: 'New JWT refresh token (rotated, 7 days)' })
  refreshToken!: string;
}
