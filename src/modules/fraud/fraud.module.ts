import { Module } from '@nestjs/common';
import { VelocityService } from './velocity.service';
import { ApprovalChainService } from './approval-chain.service';
import { DeviceFingerprintService } from './device-fingerprint.service';
import { AuditModule } from '../audit/audit.module';
import { CommonServicesModule } from '../../common/services/common-services.module';

@Module({
  imports: [AuditModule, CommonServicesModule],
  providers: [VelocityService, ApprovalChainService, DeviceFingerprintService],
  exports: [VelocityService, ApprovalChainService, DeviceFingerprintService],
})
export class FraudModule {}
