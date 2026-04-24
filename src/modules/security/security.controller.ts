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
import { IsString, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { SecurityService, ConsentAcceptDto } from './security.service';
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

class AcceptConsentDto {
  @ApiProperty({ enum: ['DATA_PROCESSING', 'STATEMENT_EXPORT', 'LOAN_TERMS'] })
  @IsEnum(['DATA_PROCESSING', 'STATEMENT_EXPORT', 'LOAN_TERMS'])
  consentType!: 'DATA_PROCESSING' | 'STATEMENT_EXPORT' | 'LOAN_TERMS';

  @ApiPropertyOptional({ default: '1.0' })
  @IsOptional()
  @IsString()
  version?: string;
}

@ApiTags('Security & Compliance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class SecurityController {
  constructor(private readonly securityService: SecurityService) {}

  // ─── Session Endpoints ─────────────────────────────────────────────────────

  @Post('auth/sessions/rotate')
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

    const newSessionId = await this.securityService.rotateSession(
      dto.sessionId,
      req.user.id,
      deviceInfo,
      req.tenant.id,
      req.ip,
    );

    return { sessionId: newSessionId };
  }

  @Get('auth/sessions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List active sessions for current user' })
  @ApiResponse({ status: 200, description: 'List of sessions' })
  async listSessions(@Req() req: AuthenticatedRequest) {
    return this.securityService.listSessions(req.user.id);
  }

  @Delete('auth/sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a specific session' })
  @ApiParam({ name: 'id', description: 'Session ID to revoke' })
  @ApiResponse({ status: 204, description: 'Session revoked' })
  async revokeSession(
    @Param('id') sessionId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.securityService.revokeSession(
      sessionId,
      req.user.id,
      req.tenant.id,
      req.ip,
    );
  }

  // ─── ODPC Consent Endpoints ────────────────────────────────────────────────

  @Get('compliance/consent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get user ODPC consents',
    description: 'Returns all consent records for the current user (Kenya Data Protection Act).',
  })
  @ApiResponse({ status: 200, description: 'List of consents' })
  async getConsents(@Req() req: AuthenticatedRequest) {
    return this.securityService.getUserConsents(req.user.id);
  }

  @Post('compliance/consent/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept ODPC consent',
    description:
      'Records user consent acceptance with IP address and timestamp. Idempotent – re-accepting same version is a no-op.',
  })
  @ApiBody({ type: AcceptConsentDto })
  @ApiResponse({ status: 200, description: 'Consent recorded' })
  async acceptConsent(
    @Body() dto: AcceptConsentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ id: string; acceptedAt: Date }> {
    const consentDto: ConsentAcceptDto = {
      consentType: dto.consentType,
      version: dto.version,
      ipAddress: req.ip ?? '0.0.0.0',
      userAgent: req.headers['user-agent'],
    };

    return this.securityService.acceptConsent(req.user.id, consentDto, req.tenant.id);
  }

  @Get('compliance/consent/check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check if user has accepted required ODPC consents' })
  @ApiResponse({ status: 200, description: 'Consent status' })
  async checkRequiredConsents(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ hasRequiredConsents: boolean }> {
    const hasRequired = await this.securityService.hasRequiredConsents(req.user.id);
    return { hasRequiredConsents: hasRequired };
  }
}
