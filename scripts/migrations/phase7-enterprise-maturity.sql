-- ============================================================================
-- Phase 7 – Enterprise Operational Maturity, Zero-Trust & Production Launch
-- Migration: Create all Phase 7 tables
-- Run: psql $DATABASE_URL -f phase7-enterprise-maturity.sql
-- ============================================================================

BEGIN;

-- ─── Data Access Log (PII Lineage) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "DataAccessLog" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"     TEXT        NOT NULL,
  "entity"       TEXT        NOT NULL,
  "entityId"     TEXT        NOT NULL,
  "field"        TEXT,
  "accessorId"   TEXT        NOT NULL,
  "accessorRole" TEXT        NOT NULL,
  "purpose"      TEXT        NOT NULL,
  "action"       TEXT        NOT NULL,
  "ipAddress"    TEXT,
  "requestId"    TEXT,
  "timestamp"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "DataAccessLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DataAccessLog_tenantId_idx"         ON "DataAccessLog" ("tenantId");
CREATE INDEX IF NOT EXISTS "DataAccessLog_tenantId_entityId_idx" ON "DataAccessLog" ("tenantId", "entityId");
CREATE INDEX IF NOT EXISTS "DataAccessLog_accessorId_idx"       ON "DataAccessLog" ("accessorId");
CREATE INDEX IF NOT EXISTS "DataAccessLog_timestamp_idx"        ON "DataAccessLog" ("timestamp");

-- ─── Consent Registry ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ConsentRegistry" (
  "id"        UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"  TEXT        NOT NULL,
  "memberId"  TEXT        NOT NULL,
  "purpose"   TEXT        NOT NULL,
  "granted"   BOOLEAN     NOT NULL,
  "version"   TEXT        NOT NULL DEFAULT '1.0',
  "channel"   TEXT        NOT NULL,
  "ipAddress" TEXT,
  "metadata"  JSONB,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "ConsentRegistry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ConsentRegistry_tenantId_memberId_idx" ON "ConsentRegistry" ("tenantId", "memberId");
CREATE INDEX IF NOT EXISTS "ConsentRegistry_tenantId_purpose_idx"  ON "ConsentRegistry" ("tenantId", "purpose");
CREATE INDEX IF NOT EXISTS "ConsentRegistry_timestamp_idx"         ON "ConsentRegistry" ("timestamp");

-- ─── Erasure Request ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ErasureRequest" (
  "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      TEXT        NOT NULL,
  "memberId"      TEXT        NOT NULL,
  "reason"        TEXT        NOT NULL,
  "requestedBy"   TEXT        NOT NULL,
  "status"        TEXT        NOT NULL DEFAULT 'PENDING',
  "jobId"         TEXT,
  "certificateId" TEXT,
  "certificate"   JSONB,
  "completedAt"   TIMESTAMPTZ,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "ErasureRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ErasureRequest_tenantId_memberId_idx" ON "ErasureRequest" ("tenantId", "memberId");
CREATE INDEX IF NOT EXISTS "ErasureRequest_status_idx"            ON "ErasureRequest" ("status");

-- ─── Partner ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Partner" (
  "id"               UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         TEXT        NOT NULL,
  "name"             TEXT        NOT NULL,
  "clientId"         TEXT        NOT NULL,
  "clientSecretHash" TEXT        NOT NULL,
  "apiKeyHash"       TEXT        NOT NULL,
  "scopes"           TEXT[]      NOT NULL DEFAULT '{}',
  "rateLimitTier"    TEXT        NOT NULL DEFAULT 'standard',
  "slaConfig"        JSONB       NOT NULL DEFAULT '{}',
  "contactName"      TEXT        NOT NULL,
  "contactEmail"     TEXT        NOT NULL,
  "contactPhone"     TEXT,
  "ipWhitelist"      TEXT[]      NOT NULL DEFAULT '{}',
  "status"           TEXT        NOT NULL DEFAULT 'PENDING_KYB',
  "suspendedReason"  TEXT,
  "activatedAt"      TIMESTAMPTZ,
  "keyRotatedAt"     TIMESTAMPTZ,
  "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "Partner_pkey"          PRIMARY KEY ("id"),
  CONSTRAINT "Partner_clientId_key"  UNIQUE ("clientId"),
  CONSTRAINT "Partner_tenantId_name" UNIQUE ("tenantId", "name")
);

CREATE INDEX IF NOT EXISTS "Partner_tenantId_idx" ON "Partner" ("tenantId");
CREATE INDEX IF NOT EXISTS "Partner_clientId_idx" ON "Partner" ("clientId");
CREATE INDEX IF NOT EXISTS "Partner_status_idx"   ON "Partner" ("status");

-- ─── Partner Usage Snapshot ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PartnerUsageSnapshot" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "partnerId"    TEXT        NOT NULL,
  "period"       TEXT        NOT NULL,
  "totalCalls"   INTEGER     NOT NULL DEFAULT 0,
  "totalErrors"  INTEGER     NOT NULL DEFAULT 0,
  "totalBytes"   INTEGER     NOT NULL DEFAULT 0,
  "avgP95Ms"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalCostKes" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "PartnerUsageSnapshot_pkey"              PRIMARY KEY ("id"),
  CONSTRAINT "PartnerUsageSnapshot_partnerId_period"  UNIQUE ("partnerId", "period"),
  CONSTRAINT "PartnerUsageSnapshot_partnerId_fkey"    FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "PartnerUsageSnapshot_partnerId_idx" ON "PartnerUsageSnapshot" ("partnerId");

-- ─── SLA Incident ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "SlaIncident" (
  "id"                UUID        NOT NULL DEFAULT gen_random_uuid(),
  "partnerId"         TEXT        NOT NULL,
  "tenantId"          TEXT        NOT NULL,
  "period"            TEXT        NOT NULL,
  "breaches"          TEXT[]      NOT NULL DEFAULT '{}',
  "actualMetrics"     JSONB       NOT NULL DEFAULT '{}',
  "contractedMetrics" JSONB       NOT NULL DEFAULT '{}',
  "status"            TEXT        NOT NULL DEFAULT 'OPEN',
  "resolvedAt"        TIMESTAMPTZ,
  "resolvedBy"        TEXT,
  "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "SlaIncident_pkey"           PRIMARY KEY ("id"),
  CONSTRAINT "SlaIncident_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "SlaIncident_partnerId_idx" ON "SlaIncident" ("partnerId");
CREATE INDEX IF NOT EXISTS "SlaIncident_tenantId_idx"  ON "SlaIncident" ("tenantId");
CREATE INDEX IF NOT EXISTS "SlaIncident_status_idx"    ON "SlaIncident" ("status");

-- ─── Executive Report ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ExecutiveReport" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    TEXT        NOT NULL,
  "period"      TEXT        NOT NULL,
  "periodType"  TEXT        NOT NULL,
  "reportData"  JSONB       NOT NULL DEFAULT '{}',
  "generatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "ExecutiveReport_pkey"                        PRIMARY KEY ("id"),
  CONSTRAINT "ExecutiveReport_tenantId_period_periodType"  UNIQUE ("tenantId", "period", "periodType")
);

CREATE INDEX IF NOT EXISTS "ExecutiveReport_tenantId_idx"    ON "ExecutiveReport" ("tenantId");
CREATE INDEX IF NOT EXISTS "ExecutiveReport_generatedAt_idx" ON "ExecutiveReport" ("generatedAt");

-- ─── Materialized View: Partner Revenue Summary ───────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_partner_revenue_monthly AS
SELECT
  p."tenantId",
  p."id"     AS "partnerId",
  p."name"   AS "partnerName",
  p."rateLimitTier",
  s."period",
  s."totalCalls",
  s."totalErrors",
  s."totalCostKes",
  s."avgP95Ms"
FROM "Partner" p
JOIN "PartnerUsageSnapshot" s ON s."partnerId" = p."id"
ORDER BY s."period" DESC, s."totalCostKes" DESC;

CREATE UNIQUE INDEX IF NOT EXISTS mv_partner_revenue_monthly_idx
  ON mv_partner_revenue_monthly ("partnerId", "period");

-- ─── Refresh function ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION refresh_phase7_views()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_partner_revenue_monthly;
END;
$$;

-- ─── Retention enforcement function ──────────────────────────────────────────
-- Purges DataAccessLog entries older than 7 years per SASRA/DPA retention policy
CREATE OR REPLACE FUNCTION enforce_data_retention(p_tenant_id TEXT)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM "DataAccessLog"
  WHERE "tenantId" = p_tenant_id
    AND "timestamp" < NOW() - INTERVAL '7 years';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMIT;

-- ─── Verify ───────────────────────────────────────────────────────────────────
DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM information_schema.tables
          WHERE table_name IN (
            'DataAccessLog', 'ConsentRegistry', 'ErasureRequest',
            'Partner', 'PartnerUsageSnapshot', 'SlaIncident', 'ExecutiveReport'
          )) = 7,
    'Phase 7 migration: not all tables created';
  RAISE NOTICE 'Phase 7 migration verified: all 7 tables present';
END;
$$;
