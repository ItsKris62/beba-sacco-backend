import { Module } from '@nestjs/common';
import { VelocityService } from './velocity.service';
import { ApprovalChainService } from './approval-chain.service';
import { DeviceFingerprintService } from './device-fingerprint.service';
import { BehavioralRiskScorerService } from './risk-scorer/behavioral-risk-scorer.service';
import { AuditModule } from '../audit/audit.module';
import { CommonServicesModule } from '../../common/services/common-services.module';

@Module({
  imports: [AuditModule, CommonServicesModule],
  providers: [
    VelocityService,
    ApprovalChainService,
    DeviceFingerprintService,
    BehavioralRiskScorerService,
  ],
  exports: [
    VelocityService,
    ApprovalChainService,
    DeviceFingerprintService,
    BehavioralRiskScorerService,
  ],
})
export class FraudModule {}
