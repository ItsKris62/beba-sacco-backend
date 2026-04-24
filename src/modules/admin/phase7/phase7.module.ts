/**
 * Phase 7 – Enterprise Operational Maturity Module
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { Phase7AdminController } from './phase7-admin.controller';
import { EncryptionService } from '../../zero-trust/encryption/encryption.service';
import { SecretRotationService } from '../../zero-trust/secret-rotation/secret-rotation.service';
import { ThreatDetectionService } from '../../zero-trust/threat-detection/threat-detection.service';
import { PiiTokenizationService } from '../../zero-trust/pii-tokenization/pii-tokenization.service';
import { LineageService } from '../../governance/lineage/lineage.service';
import { DataErasureService } from '../../governance/erasure/data-erasure.service';
import { ConsentRegistryService } from '../../governance/consent/consent-registry.service';
import { PartnerOnboardingService } from '../../partners/partner-onboarding.service';
import { BillingService } from '../../partners/billing.service';
import { SlaMonitorService } from '../../partners/sla-monitor.service';
import { ExecutiveReportService } from '../../reports/executive-report.service';
import { StressTestService } from '../../reports/stress-test.service';
import { SloTrackerService } from '../../sre/slo-tracker.service';
import { FinOpsService } from '../../sre/finops.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { CommonServicesModule } from '../../../common/services/common-services.module';
import { QUEUE_NAMES } from '../../queue/queue.constants';

@Module({
  imports: [
    CommonServicesModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.SECRET_ROTATION },
      { name: QUEUE_NAMES.DATA_ERASURE },
      { name: QUEUE_NAMES.PARTNER_PROVISION },
      { name: QUEUE_NAMES.REGULATORY_SUBMISSION },
      { name: QUEUE_NAMES.EXECUTIVE_REPORT },
      { name: QUEUE_NAMES.DR_DRILL },
    ),
  ],
  controllers: [Phase7AdminController],
  providers: [
    PrismaService,
    // Zero-Trust
    EncryptionService,
    SecretRotationService,
    ThreatDetectionService,
    PiiTokenizationService,
    // Data Governance
    LineageService,
    DataErasureService,
    ConsentRegistryService,
    // Partners
    PartnerOnboardingService,
    BillingService,
    SlaMonitorService,
    // Reports
    ExecutiveReportService,
    StressTestService,
    // SRE
    SloTrackerService,
    FinOpsService,
  ],
  exports: [
    EncryptionService,
    PiiTokenizationService,
    ThreatDetectionService,
    LineageService,
    ConsentRegistryService,
    SloTrackerService,
    BillingService,
  ],
})
export class Phase7Module {}
