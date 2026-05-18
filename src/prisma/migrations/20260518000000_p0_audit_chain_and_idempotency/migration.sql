CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "AuditEvent" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "correlationId" TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  "tenantId" TEXT NOT NULL REFERENCES "Tenant"(id) ON DELETE CASCADE,
  "userId" TEXT NULL,
  role TEXT NULL,
  action TEXT NOT NULL,
  "resourceType" TEXT NULL,
  "resourceId" TEXT NULL,
  "oldState" JSONB NULL,
  "newState" JSONB NULL,
  metadata JSONB NULL,
  ip TEXT NULL,
  "userAgent" TEXT NULL,
  endpoint TEXT NULL,
  method TEXT NULL,
  "statusCode" INTEGER NOT NULL,
  success BOOLEAN NOT NULL,
  "errorCode" TEXT NULL,
  "prevHash" TEXT NOT NULL,
  "eventHash" TEXT NOT NULL,
  signature TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "AuditEvent_tenantId_timestamp_idx"
  ON "AuditEvent" ("tenantId", timestamp DESC);

CREATE INDEX IF NOT EXISTS "AuditEvent_correlationId_idx"
  ON "AuditEvent" ("correlationId");

CREATE UNIQUE INDEX IF NOT EXISTS "AuditEvent_tenantId_eventHash_key"
  ON "AuditEvent" ("tenantId", "eventHash");

CREATE TABLE IF NOT EXISTS "AuditChainHead" (
  "tenantId" TEXT PRIMARY KEY REFERENCES "Tenant"(id) ON DELETE CASCADE,
  "lastHash" TEXT NOT NULL DEFAULT 'GENESIS',
  sequence BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_archive_manifests (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL REFERENCES "Tenant"(id) ON DELETE CASCADE,
  "archiveClass" TEXT NOT NULL,
  "cutoffAt" TIMESTAMPTZ NOT NULL,
  "objectUri" TEXT NOT NULL,
  "rowCount" INTEGER NOT NULL DEFAULT 0,
  "manifestHash" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_archive_manifests_tenant_cutoff_idx
  ON audit_archive_manifests ("tenantId", "cutoffAt" DESC);

ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditChainHead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_archive_manifests ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'AuditEvent' AND policyname = 'tenant_isolation_audit_event'
  ) THEN
    CREATE POLICY tenant_isolation_audit_event ON "AuditEvent"
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END $$;
