import { IsUrl, IsArray, IsString, ArrayMinSize, ArrayMaxSize, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const WEBHOOK_EVENTS = [
  'loan.status_changed',
  'repayment.posted',
  'kyc.updated',
  'member.created',
  'mpesa.deposit_completed',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export class CreateWebhookDto {
  @ApiProperty({ description: 'HTTPS target URL', example: 'https://partner.example.com/hooks/sacco' })
  @IsUrl({ require_tld: true, protocols: ['https'] })
  url!: string;

  @ApiProperty({
    description: 'Events to subscribe to',
    enum: WEBHOOK_EVENTS,
    isArray: true,
    example: ['loan.status_changed', 'repayment.posted'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  events!: string[];

  @ApiPropertyOptional({ description: 'HMAC signing secret (auto-generated if omitted)' })
  @IsOptional()
  @IsString()
  secret?: string;
}
