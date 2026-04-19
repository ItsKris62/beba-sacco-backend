-- CreateEnum
CREATE TYPE "public"."OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "public"."AmlScreeningStatus" AS ENUM ('PENDING', 'CLEAR', 'FLAGGED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "public"."CrbReportStatus" AS ENUM ('PENDING', 'QUEUED', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."DsarRequestStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'EXPIRED', 'REDACTED');

-- CreateEnum
CREATE TYPE "public"."NotificationChannel" AS ENUM ('EMAIL', 'SMS', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "public"."NotificationStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."ApiClientStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "public"."ComplianceAlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "public"."ComplianceAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "public"."FeatureFlagStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "public"."IntegrationOutbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "integrationType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "public"."OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "nextRetryAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CrbReport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanIds" TEXT[],
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "xmlPayload" TEXT NOT NULL,
    "status" "public"."CrbReportStatus" NOT NULL DEFAULT 'PENDING',
    "submittedAt" TIMESTAMP(3),
    "responseCode" TEXT,
    "responseMessage" TEXT,
    "outboxId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrbReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AmlScreening" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "triggerRef" TEXT,
    "riskScore" INTEGER,
    "status" "public"."AmlScreeningStatus" NOT NULL DEFAULT 'PENDING',
    "watchlistMatches" JSONB,
    "screenedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewNotes" TEXT,
    "outboxId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmlScreening_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProvisioningEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "calculationDate" TIMESTAMP(3) NOT NULL,
    "staging" "public"."LoanStaging" NOT NULL,
    "pd" DECIMAL(10,6) NOT NULL,
    "lgd" DECIMAL(10,6) NOT NULL,
    "ead" DECIMAL(18,4) NOT NULL,
    "eclAmount" DECIMAL(18,4) NOT NULL,
    "macroAdjustment" DECIMAL(7,4) NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProvisioningEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DsarRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" "public"."DsarRequestStatus" NOT NULL DEFAULT 'PENDING',
    "downloadUrl" TEXT,
    "expiresAt" TIMESTAMP(3),
    "redactedAt" TIMESTAMP(3),
    "auditTrail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DsarRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SasraRatioSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "liquidAssets" DECIMAL(18,4) NOT NULL,
    "shortTermLiabilities" DECIMAL(18,4) NOT NULL,
    "liquidityRatio" DECIMAL(10,6) NOT NULL,
    "coreCapital" DECIMAL(18,4) NOT NULL,
    "totalAssets" DECIMAL(18,4) NOT NULL,
    "capitalAdequacyRatio" DECIMAL(10,6) NOT NULL,
    "totalLoans" DECIMAL(18,4) NOT NULL,
    "nplAmount" DECIMAL(18,4) NOT NULL,
    "portfolioQualityRatio" DECIMAL(10,6) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SasraRatioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CbkReturn" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "csvPayload" TEXT NOT NULL,
    "loanPortfolio" DECIMAL(18,4) NOT NULL,
    "nplRatio" DECIMAL(10,6) NOT NULL,
    "depositGrowth" DECIMAL(10,6) NOT NULL,
    "capitalAdequacy" DECIMAL(10,6) NOT NULL,
    "filingDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CbkReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ApiClient" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scopes" TEXT[],
    "rateLimitTier" TEXT NOT NULL DEFAULT 'partner',
    "status" "public"."ApiClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "webhookUrl" TEXT,
    "ipWhitelist" TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."NotificationLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberId" TEXT,
    "channel" "public"."NotificationChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "public"."NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "cost" DECIMAL(10,4),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ComplianceAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policy" TEXT NOT NULL,
    "severity" "public"."ComplianceAlertSeverity" NOT NULL DEFAULT 'WARNING',
    "status" "public"."ComplianceAlertStatus" NOT NULL DEFAULT 'OPEN',
    "message" TEXT NOT NULL,
    "details" JSONB,
    "remediation" TEXT,
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FeatureFlag" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "status" "public"."FeatureFlagStatus" NOT NULL DEFAULT 'ACTIVE',
    "rolloutPct" INTEGER NOT NULL DEFAULT 100,
    "tenantIds" TEXT[],
    "roles" TEXT[],
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RiskScore" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "flags" TEXT[],
    "recommendation" TEXT NOT NULL,
    "details" JSONB,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FeatureSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "features" JSONB NOT NULL,
    "exportedAt" TIMESTAMP(3),
    "storagePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TenantRegionConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "primaryDsn" TEXT NOT NULL,
    "replicaDsn" TEXT,
    "piiRegion" TEXT NOT NULL,
    "allowCrossRegionExport" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantRegionConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CanaryDeployment" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "trafficPct" INTEGER NOT NULL DEFAULT 10,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "p95Latency" DECIMAL(10,2),
    "errorRate" DECIMAL(10,6),
    "queueDepth" INTEGER,
    "baselineP95" DECIMAL(10,2),
    "baselineErr" DECIMAL(10,6),
    "rollbackReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CanaryDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DataAccessLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "field" TEXT,
    "accessorId" TEXT NOT NULL,
    "accessorRole" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "ipAddress" TEXT,
    "requestId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ConsentRegistry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "channel" TEXT NOT NULL,
    "ipAddress" TEXT,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRegistry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ErasureRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "jobId" TEXT,
    "certificateId" TEXT,
    "certificate" JSONB,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErasureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Partner" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "rateLimitTier" TEXT NOT NULL DEFAULT 'standard',
    "slaConfig" JSONB NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "ipWhitelist" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PENDING_KYB',
    "suspendedReason" TEXT,
    "activatedAt" TIMESTAMP(3),
    "keyRotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PartnerUsageSnapshot" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "totalCalls" INTEGER NOT NULL DEFAULT 0,
    "totalErrors" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" INTEGER NOT NULL DEFAULT 0,
    "avgP95Ms" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCostKes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerUsageSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SlaIncident" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "breaches" TEXT[],
    "actualMetrics" JSONB NOT NULL,
    "contractedMetrics" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlaIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExecutiveReport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "periodType" TEXT NOT NULL,
    "reportData" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutiveReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationOutbox_idempotencyKey_key" ON "public"."IntegrationOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "IntegrationOutbox_tenantId_idx" ON "public"."IntegrationOutbox"("tenantId");

-- CreateIndex
CREATE INDEX "IntegrationOutbox_status_nextRetryAt_idx" ON "public"."IntegrationOutbox"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "IntegrationOutbox_integrationType_status_idx" ON "public"."IntegrationOutbox"("integrationType", "status");

-- CreateIndex
CREATE INDEX "CrbReport_tenantId_idx" ON "public"."CrbReport"("tenantId");

-- CreateIndex
CREATE INDEX "CrbReport_status_idx" ON "public"."CrbReport"("status");

-- CreateIndex
CREATE INDEX "CrbReport_periodStart_periodEnd_idx" ON "public"."CrbReport"("periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "AmlScreening_tenantId_idx" ON "public"."AmlScreening"("tenantId");

-- CreateIndex
CREATE INDEX "AmlScreening_memberId_idx" ON "public"."AmlScreening"("memberId");

-- CreateIndex
CREATE INDEX "AmlScreening_status_idx" ON "public"."AmlScreening"("status");

-- CreateIndex
CREATE INDEX "ProvisioningEntry_tenantId_calculationDate_idx" ON "public"."ProvisioningEntry"("tenantId", "calculationDate");

-- CreateIndex
CREATE INDEX "ProvisioningEntry_tenantId_staging_idx" ON "public"."ProvisioningEntry"("tenantId", "staging");

-- CreateIndex
CREATE UNIQUE INDEX "ProvisioningEntry_tenantId_loanId_calculationDate_key" ON "public"."ProvisioningEntry"("tenantId", "loanId", "calculationDate");

-- CreateIndex
CREATE INDEX "DsarRequest_tenantId_idx" ON "public"."DsarRequest"("tenantId");

-- CreateIndex
CREATE INDEX "DsarRequest_memberId_idx" ON "public"."DsarRequest"("memberId");

-- CreateIndex
CREATE INDEX "DsarRequest_status_idx" ON "public"."DsarRequest"("status");

-- CreateIndex
CREATE INDEX "SasraRatioSnapshot_tenantId_idx" ON "public"."SasraRatioSnapshot"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "SasraRatioSnapshot_tenantId_period_key" ON "public"."SasraRatioSnapshot"("tenantId", "period");

-- CreateIndex
CREATE INDEX "CbkReturn_tenantId_idx" ON "public"."CbkReturn"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CbkReturn_tenantId_period_version_key" ON "public"."CbkReturn"("tenantId", "period", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ApiClient_clientId_key" ON "public"."ApiClient"("clientId");

-- CreateIndex
CREATE INDEX "ApiClient_tenantId_idx" ON "public"."ApiClient"("tenantId");

-- CreateIndex
CREATE INDEX "ApiClient_clientId_idx" ON "public"."ApiClient"("clientId");

-- CreateIndex
CREATE INDEX "NotificationLog_tenantId_idx" ON "public"."NotificationLog"("tenantId");

-- CreateIndex
CREATE INDEX "NotificationLog_memberId_idx" ON "public"."NotificationLog"("memberId");

-- CreateIndex
CREATE INDEX "NotificationLog_status_idx" ON "public"."NotificationLog"("status");

-- CreateIndex
CREATE INDEX "NotificationLog_channel_status_idx" ON "public"."NotificationLog"("channel", "status");

-- CreateIndex
CREATE INDEX "ComplianceAlert_tenantId_idx" ON "public"."ComplianceAlert"("tenantId");

-- CreateIndex
CREATE INDEX "ComplianceAlert_tenantId_status_idx" ON "public"."ComplianceAlert"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ComplianceAlert_policy_idx" ON "public"."ComplianceAlert"("policy");

-- CreateIndex
CREATE INDEX "ComplianceAlert_createdAt_idx" ON "public"."ComplianceAlert"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_key_key" ON "public"."FeatureFlag"("key");

-- CreateIndex
CREATE INDEX "FeatureFlag_key_idx" ON "public"."FeatureFlag"("key");

-- CreateIndex
CREATE INDEX "FeatureFlag_status_idx" ON "public"."FeatureFlag"("status");

-- CreateIndex
CREATE INDEX "RiskScore_tenantId_memberId_idx" ON "public"."RiskScore"("tenantId", "memberId");

-- CreateIndex
CREATE INDEX "RiskScore_tenantId_context_idx" ON "public"."RiskScore"("tenantId", "context");

-- CreateIndex
CREATE INDEX "RiskScore_evaluatedAt_idx" ON "public"."RiskScore"("evaluatedAt");

-- CreateIndex
CREATE INDEX "FeatureSnapshot_tenantId_idx" ON "public"."FeatureSnapshot"("tenantId");

-- CreateIndex
CREATE INDEX "FeatureSnapshot_tenantId_memberId_idx" ON "public"."FeatureSnapshot"("tenantId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureSnapshot_tenantId_memberId_version_key" ON "public"."FeatureSnapshot"("tenantId", "memberId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "TenantRegionConfig_tenantId_key" ON "public"."TenantRegionConfig"("tenantId");

-- CreateIndex
CREATE INDEX "TenantRegionConfig_tenantId_idx" ON "public"."TenantRegionConfig"("tenantId");

-- CreateIndex
CREATE INDEX "TenantRegionConfig_region_idx" ON "public"."TenantRegionConfig"("region");

-- CreateIndex
CREATE INDEX "CanaryDeployment_status_idx" ON "public"."CanaryDeployment"("status");

-- CreateIndex
CREATE INDEX "CanaryDeployment_startedAt_idx" ON "public"."CanaryDeployment"("startedAt");

-- CreateIndex
CREATE INDEX "DataAccessLog_tenantId_idx" ON "public"."DataAccessLog"("tenantId");

-- CreateIndex
CREATE INDEX "DataAccessLog_tenantId_entityId_idx" ON "public"."DataAccessLog"("tenantId", "entityId");

-- CreateIndex
CREATE INDEX "DataAccessLog_accessorId_idx" ON "public"."DataAccessLog"("accessorId");

-- CreateIndex
CREATE INDEX "DataAccessLog_timestamp_idx" ON "public"."DataAccessLog"("timestamp");

-- CreateIndex
CREATE INDEX "ConsentRegistry_tenantId_memberId_idx" ON "public"."ConsentRegistry"("tenantId", "memberId");

-- CreateIndex
CREATE INDEX "ConsentRegistry_tenantId_purpose_idx" ON "public"."ConsentRegistry"("tenantId", "purpose");

-- CreateIndex
CREATE INDEX "ConsentRegistry_timestamp_idx" ON "public"."ConsentRegistry"("timestamp");

-- CreateIndex
CREATE INDEX "ErasureRequest_tenantId_memberId_idx" ON "public"."ErasureRequest"("tenantId", "memberId");

-- CreateIndex
CREATE INDEX "ErasureRequest_status_idx" ON "public"."ErasureRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_clientId_key" ON "public"."Partner"("clientId");

-- CreateIndex
CREATE INDEX "Partner_tenantId_idx" ON "public"."Partner"("tenantId");

-- CreateIndex
CREATE INDEX "Partner_clientId_idx" ON "public"."Partner"("clientId");

-- CreateIndex
CREATE INDEX "Partner_status_idx" ON "public"."Partner"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_tenantId_name_key" ON "public"."Partner"("tenantId", "name");

-- CreateIndex
CREATE INDEX "PartnerUsageSnapshot_partnerId_idx" ON "public"."PartnerUsageSnapshot"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerUsageSnapshot_partnerId_period_key" ON "public"."PartnerUsageSnapshot"("partnerId", "period");

-- CreateIndex
CREATE INDEX "SlaIncident_partnerId_idx" ON "public"."SlaIncident"("partnerId");

-- CreateIndex
CREATE INDEX "SlaIncident_tenantId_idx" ON "public"."SlaIncident"("tenantId");

-- CreateIndex
CREATE INDEX "SlaIncident_status_idx" ON "public"."SlaIncident"("status");

-- CreateIndex
CREATE INDEX "ExecutiveReport_tenantId_idx" ON "public"."ExecutiveReport"("tenantId");

-- CreateIndex
CREATE INDEX "ExecutiveReport_generatedAt_idx" ON "public"."ExecutiveReport"("generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutiveReport_tenantId_period_periodType_key" ON "public"."ExecutiveReport"("tenantId", "period", "periodType");

-- AddForeignKey
ALTER TABLE "public"."PartnerUsageSnapshot" ADD CONSTRAINT "PartnerUsageSnapshot_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SlaIncident" ADD CONSTRAINT "SlaIncident_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
