import { Module } from '@nestjs/common';
import { VelocityService } from './velocity.service';
import { ApprovalChainService } from './approval-chain.service';
import { DeviceFingerprintService } from './device-fingerprint.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  providers: [VelocityService, ApprovalChainService, DeviceFingerprintService],
  exports: [VelocityService, ApprovalChainService, DeviceFingerprintService],
})
export class FraudModule {}
