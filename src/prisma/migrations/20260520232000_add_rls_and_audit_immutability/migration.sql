-- Phase 2: Tenant-isolation RLS policies and database-enforced AuditLog immutability.
-- RLS policies are feature-flag aware. They allow existing behavior unless
-- app.rls_enabled is set to 'true' on the PostgreSQL session.

ALTER TABLE "public"."Document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Member" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Account" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "document_tenant_isolation" ON "public"."Document";
CREATE POLICY "document_tenant_isolation" ON "public"."Document"
  FOR ALL
  USING (
    COALESCE(current_setting('app.rls_enabled', true), 'false') <> 'true'
    OR COALESCE(current_setting('app.bypass_rls', true), 'false') = 'true'
    OR "tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')
  )
  WITH CHECK (
    COALESCE(current_setting('app.rls_enabled', true), 'false') <> 'true'
    OR COALESCE(current_setting('app.bypass_rls', true), 'false') = 'true'
    OR "tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')
  );

DROP POLICY IF EXISTS "member_tenant_isolation" ON "public"."Member";
CREATE POLICY "member_tenant_isolation" ON "public"."Member"
  FOR ALL
  USING (
    COALESCE(current_setting('app.rls_enabled', true), 'false') <> 'true'
    OR COALESCE(current_setting('app.bypass_rls', true), 'false') = 'true'
    OR "tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')
  )
  WITH CHECK (
    COALESCE(current_setting('app.rls_enabled', true), 'false') <> 'true'
    OR COALESCE(current_setting('app.bypass_rls', true), 'false') = 'true'
    OR "tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')
  );

DROP POLICY IF EXISTS "account_tenant_isolation" ON "public"."Account";
CREATE POLICY "account_tenant_isolation" ON "public"."Account"
  FOR ALL
  USING (
    COALESCE(current_setting('app.rls_enabled', true), 'false') <> 'true'
    OR COALESCE(current_setting('app.bypass_rls', true), 'false') = 'true'
    OR "tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')
  )
  WITH CHECK (
    COALESCE(current_setting('app.rls_enabled', true), 'false') <> 'true'
    OR COALESCE(current_setting('app.bypass_rls', true), 'false') = 'true'
    OR "tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')
  );

CREATE OR REPLACE FUNCTION "public"."prevent_auditlog_modification"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_IMMUTABLE: AuditLog records cannot be modified. Attempted % on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS "audit_immutable_trigger" ON "public"."AuditLog";
CREATE TRIGGER "audit_immutable_trigger"
  BEFORE UPDATE OR DELETE ON "public"."AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "public"."prevent_auditlog_modification"();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE UPDATE, DELETE ON "public"."AuditLog" FROM app_user;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beba_app_user') THEN
    REVOKE UPDATE, DELETE ON "public"."AuditLog" FROM beba_app_user;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "AuditLog_tenantId_entityType_action_idx"
  ON "public"."AuditLog" ("tenantId", "entityType", "action");
