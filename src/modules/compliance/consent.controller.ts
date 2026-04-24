import {
  Controller,
  Get,
  Post,
  Body,
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
} from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { ConsentService } from './consent.service';
import type { AuthenticatedRequest } from '../../common/types/request.types';

class AcceptConsentDto {
  @ApiProperty({ enum: ['DATA_PROCESSING', 'STATEMENT_EXPORT', 'LOAN_TERMS'] })
  @IsEnum(['DATA_PROCESSING', 'STATEMENT_EXPORT', 'LOAN_TERMS'])
  consentType!: 'DATA_PROCESSING' | 'STATEMENT_EXPORT' | 'LOAN_TERMS';

  @ApiPropertyOptional({ default: '1.0' })
  @IsOptional()
  @IsString()
  version?: string;
}

@ApiTags('Consent')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('compliance/consent')
export class ConsentController {
  constructor(private readonly consentService: ConsentService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get user ODPC consents',
    description: 'Returns all consent records for the current user (Kenya Data Protection Act).',
  })
  @ApiResponse({ status: 200, description: 'List of consents' })
  async getConsents(@Req() req: AuthenticatedRequest) {
    return this.consentService.getUserConsents(req.user.id);
  }

  @Post('accept')
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
    return this.consentService.acceptConsent(
      req.user.id,
      {
        consentType: dto.consentType,
        version: dto.version,
        ipAddress: req.ip ?? '0.0.0.0',
        userAgent: req.headers['user-agent'],
      },
      req.tenant.id,
    );
  }

  @Get('check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check if user has accepted required ODPC consents' })
  @ApiResponse({ status: 200, description: 'Consent status' })
  async checkRequiredConsents(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ hasRequiredConsents: boolean }> {
    const hasRequired = await this.consentService.hasRequiredConsents(req.user.id);
    return { hasRequiredConsents: hasRequired };
  }
}
