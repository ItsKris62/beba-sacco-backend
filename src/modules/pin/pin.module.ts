import { Module } from '@nestjs/common';
import { PinService } from './pin.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { AuditModule } from '../audit/audit.module';
import { SmsModule } from '../sms/sms.module';

/**
 * PIN Module
 *
 * Owns temp-PIN issuance/validation for first-login onboarding and phone-based
 * password reset. Delegates SMS delivery to SmsModule (Africa's Talking via
 * BullMQ) and audit trail writes to AuditModule.
 */
@Module({
  imports: [AuditModule, SmsModule],
  providers: [PinService, PrismaService, RedisService],
  exports: [PinService],
})
export class PinModule {}
