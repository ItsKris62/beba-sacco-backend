import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { SessionService } from './session.service';
import type { AuthenticatedRequest } from '../../common/types/request.types';

class RotateSessionDto {
  @ApiProperty({ description: 'Current session ID to rotate' })
  @IsString()
  sessionId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  screenRes?: string;
}

@ApiTags('Sessions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('auth/sessions')
export class SessionController {
  constructor(private readonly sessionService: SessionService) {}

  @Post('rotate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate refresh session',
    description:
      'Invalidates the current session and issues a new one. Device fingerprint is validated. Detects token reuse attacks.',
  })
  @ApiBody({ type: RotateSessionDto })
  @ApiResponse({ status: 200, description: 'New session ID returned' })
  async rotateSession(
    @Body() dto: RotateSessionDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ sessionId: string }> {
    const deviceInfo = {
      userAgent: req.headers['user-agent'] ?? 'unknown',
      timezone: dto.timezone,
      screenRes: dto.screenRes,
    };

    const newSessionId = await this.sessionService.rotateSession(
      dto.sessionId,
      req.user.id,
      deviceInfo,
      req.tenant.id,
      req.ip,
    );

    return { sessionId: newSessionId };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List active sessions for current user' })
  @ApiResponse({ status: 200, description: 'List of sessions' })
  async listSessions(@Req() req: AuthenticatedRequest) {
    return this.sessionService.listSessions(req.user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a specific session' })
  @ApiParam({ name: 'id', description: 'Session ID to revoke' })
  @ApiResponse({ status: 204, description: 'Session revoked' })
  async revokeSession(
    @Param('id') sessionId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.sessionService.revokeSession(
      sessionId,
      req.user.id,
      req.tenant.id,
      req.ip,
    );
  }
}
