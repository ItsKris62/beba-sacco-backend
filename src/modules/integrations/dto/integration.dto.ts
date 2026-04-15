import { IsArray, IsEnum, IsNotEmpty, IsOptional, IsString, IsUrl, ArrayMinSize } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── CRB Report ──────────────────────────────────────────────────────────────

export class CreateCrbReportDto {
  @ApiProperty({ description: 'Loan UUIDs to include in report', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  loanIds: string[];

  @ApiProperty({ example: '2025-01-01' })
  @IsString()
  @IsNotEmpty()
  periodStart: string;

  @ApiProperty({ example: '2025-03-31' })
  @IsString()
  @IsNotEmpty()
  periodEnd: string;
}

// ── AML Screening ───────────────────────────────────────────────────────────

export class CreateAmlScreeningDto {
  @ApiProperty({ description: 'Member UUID to screen' })
  @IsString()
  @IsNotEmpty()
  memberId: string;

  @ApiProperty({ enum: ['KYC', 'DEPOSIT', 'MANUAL'] })
  @IsEnum(['KYC', 'DEPOSIT', 'MANUAL'])
  trigger: 'KYC' | 'DEPOSIT' | 'MANUAL';

  @ApiPropertyOptional({ description: 'Reference ID (e.g., transaction ID for deposit triggers)' })
  @IsOptional()
  @IsString()
  triggerRef?: string;
}

// ── DSAR Request ────────────────────────────────────────────────────────────

export class CreateDsarRequestDto {
  @ApiProperty({ description: 'Member UUID for data subject access request' })
  @IsString()
  @IsNotEmpty()
  memberId: string;
}

// ── API Client Registration ─────────────────────────────────────────────────

export class RegisterApiClientDto {
  @ApiProperty({ description: 'Partner name' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'OAuth2 scopes',
    type: [String],
    example: ['read:loans', 'read:members'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  scopes: string[];

  @ApiPropertyOptional({ enum: ['internal', 'partner', 'public'], default: 'partner' })
  @IsOptional()
  @IsString()
  rateLimitTier?: string;

  @ApiPropertyOptional({ description: 'Webhook URL for partner notifications' })
  @IsOptional()
  @IsUrl()
  webhookUrl?: string;

  @ApiPropertyOptional({ description: 'IP whitelist', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ipWhitelist?: string[];
}

export class TokenExchangeDto {
  @ApiProperty({ description: 'OAuth2 client_id' })
  @IsString()
  @IsNotEmpty()
  client_id: string;

  @ApiProperty({ description: 'OAuth2 client_secret' })
  @IsString()
  @IsNotEmpty()
  client_secret: string;

  @ApiPropertyOptional({ description: 'Requested scopes (space-separated)' })
  @IsOptional()
  @IsString()
  scope?: string;
}

// ── Partner Webhook Registration ────────────────────────────────────────────

export class RegisterPartnerWebhookDto {
  @ApiProperty({ description: 'Webhook target URL' })
  @IsUrl()
  url: string;

  @ApiProperty({ description: 'Events to subscribe to', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  events: string[];

  @ApiPropertyOptional({ description: 'HMAC signing secret (auto-generated if omitted)' })
  @IsOptional()
  @IsString()
  secret?: string;
}
