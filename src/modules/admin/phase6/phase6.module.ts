import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../../queue/queue.constants';

// Analytics
import { CdcMiddlewareService } from '../../analytics/cdc/cdc-middleware.service';
import { AnalyticsStreamProcessor } from '../../analytics/cdc/analytics-stream.processor';
import { RealTimeAnalyticsService } from '../../analytics/sse/real-time-analytics.service';

// Risk & Fraud
import { BehavioralRiskScorerService } from '../../fraud/risk-scorer/behavioral-risk-scorer.service';
import { DynamicRuleEngineService } from '../../fraud/risk-scorer/dynamic-rule-engine.service';
import { FeatureStoreService } from '../../fraud/risk-scorer/feature-store.service';

// Compliance
import { PolicyEngineService } from '../../compliance/policy-engine/policy-engine.service';

// Audit
import { AuditChainService } from '../../audit/audit-chain.service';

// Feature Flags
import { FeatureFlagService } from '../feature-flags/feature-flag.service';

// Multi-Region
import { MultiRegionService } from '../../tenants/multi-region/multi-region.service';

// Canary
import { CanaryService } from '../../deploy/canary/canary.service';

// Controller
import { Phase6AdminController } from './phase6-admin.controller';

// Storage
import { StorageModule } from '../../storage/storage.module';

// Prisma
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Phase 6 Module
 *
 * Wires all Phase 6 services:
 *  - CDC stream → analytics queue → materialized view refresh
 *  - SSE real-time analytics with Redis PubSub
 *  - Behavioral risk scorer + guarantor ring detection
 *  - ML feature store + dynamic rule engine
 *  - Policy engine (CBK/SASRA/ODPC)
 *  - Cryptographic audit chain
 *  - Feature flags (hot-reload)
 *  - Multi-region routing + data residency
 *  - Canary deployment analysis
 */
@Module({
  imports: [
    StorageModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.ANALYTICS_STREAM },
      { name: QUEUE_NAMES.RISK_SCORE },
      { name: QUEUE_NAMES.COMPLIANCE_CHECK },
      { name: QUEUE_NAMES.FEATURE_STORE_EXPORT },
      { name: QUEUE_NAMES.CANARY_ANALYSIS },
    ),
  ],
  controllers: [Phase6AdminController],
  providers: [
    PrismaService,
    // Analytics
    CdcMiddlewareService,
    AnalyticsStreamProcessor,
    RealTimeAnalyticsService,
    // Risk & Fraud
    BehavioralRiskScorerService,
    DynamicRuleEngineService,
    FeatureStoreService,
    // Compliance
    PolicyEngineService,
    // Audit
    AuditChainService,
    // Feature Flags
    FeatureFlagService,
    // Multi-Region
    MultiRegionService,
    // Canary
    CanaryService,
  ],
  exports: [
    AuditChainService,
    FeatureFlagService,
    PolicyEngineService,
    BehavioralRiskScorerService,
    MultiRegionService,
    RealTimeAnalyticsService,
    CanaryService,
  ],
})
export class Phase6Module {}
