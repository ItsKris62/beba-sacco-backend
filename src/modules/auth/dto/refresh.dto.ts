import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token received from login or previous refresh' })
  @IsString()
  @MinLength(10)
  refreshToken!: string;
}

export class RefreshTokenResponseDto {
  @ApiProperty({ description: 'New JWT access token (15 min)' })
  accessToken!: string;

  @ApiProperty({ description: 'New JWT refresh token (rotated, 7 days)' })
  refreshToken!: string;
}
