-- Phase 6: Materialized Views for Real-Time Analytics
-- PostgreSQL 15 – Run after prisma migrate deploy
-- Refresh strategy: CONCURRENTLY via BullMQ analytics queue processor

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Member Liquidity View
--    Tracks per-tenant liquid asset position
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_member_liquidity AS
SELECT
  a."tenantId",
  COUNT(DISTINCT a.id)                                    AS total_accounts,
  SUM(a.balance)                                          AS total_balance,
  SUM(CASE WHEN a."accountType" = 'FOSA' THEN a.balance ELSE 0 END) AS fosa_balance,
  SUM(CASE WHEN a."accountType" = 'BOSA' THEN a.balance ELSE 0 END) AS bosa_balance,
  AVG(a.balance)                                          AS avg_balance,
  NOW()                                                   AS refreshed_at
FROM "Account" a
WHERE a."isActive" = true
GROUP BY a."tenantId";

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_member_liquidity_tenant
  ON mv_member_liquidity ("tenantId");

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Loan Pipeline Velocity View
--    Tracks loan application throughput and approval rates
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_loan_pipeline_velocity AS
SELECT
  l."tenantId",
  COUNT(*)                                                AS total_loans,
  COUNT(CASE WHEN l.status IN ('DRAFT','PENDING_GUARANTORS','UNDER_REVIEW','PENDING_APPROVAL') THEN 1 END) AS pipeline_count,
  COUNT(CASE WHEN l.status IN ('ACTIVE','DISBURSED') THEN 1 END)    AS active_count,
  COUNT(CASE WHEN l.status = 'FULLY_PAID' THEN 1 END)               AS paid_count,
  COUNT(CASE WHEN l.status IN ('DEFAULTED','WRITTEN_OFF') THEN 1 END) AS bad_debt_count,
  SUM(CASE WHEN l.status IN ('ACTIVE','DISBURSED') THEN l."outstandingBalance" ELSE 0 END) AS total_outstanding,
  AVG(CASE WHEN l.status = 'DISBURSED'
    THEN EXTRACT(EPOCH FROM (l."disbursedAt" - l."createdAt")) / 86400
    ELSE NULL END)                                        AS avg_approval_days,
  NOW()                                                   AS refreshed_at
FROM "Loan" l
GROUP BY l."tenantId";

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_loan_pipeline_tenant
  ON mv_loan_pipeline_velocity ("tenantId");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Daily Deposit Inflow View
--    Tracks deposit activity by day and tenant
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_deposit_inflow AS
SELECT
  t."tenantId",
  DATE_TRUNC('day', t."createdAt")                        AS deposit_date,
  COUNT(*)                                                AS transaction_count,
  SUM(t.amount)                                           AS total_amount,
  AVG(t.amount)                                           AS avg_amount,
  MAX(t.amount)                                           AS max_amount,
  NOW()                                                   AS refreshed_at
FROM "Transaction" t
WHERE t.type = 'DEPOSIT'
  AND t.status = 'COMPLETED'
  AND t."createdAt" >= NOW() - INTERVAL '90 days'
GROUP BY t."tenantId", DATE_TRUNC('day', t."createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_daily_deposit_tenant_date
  ON mv_daily_deposit_inflow ("tenantId", deposit_date);

CREATE INDEX IF NOT EXISTS idx_mv_daily_deposit_date
  ON mv_daily_deposit_inflow (deposit_date DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Guarantor Network Density View
--    Tracks guarantor relationship density per tenant (ring detection support)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_guarantor_network_density AS
SELECT
  g."tenantId",
  COUNT(DISTINCT g."memberId")                            AS unique_guarantors,
  COUNT(DISTINCT g."loanId")                              AS guaranteed_loans,
  COUNT(*)                                                AS total_guarantorships,
  AVG(sub.guarantor_count)                                AS avg_guarantors_per_loan,
  MAX(sub.guarantor_count)                                AS max_guarantors_per_loan,
  NOW()                                                   AS refreshed_at
FROM "Guarantor" g
JOIN (
  SELECT "loanId", COUNT(*) AS guarantor_count
  FROM "Guarantor"
  WHERE status = 'ACCEPTED'
  GROUP BY "loanId"
) sub ON sub."loanId" = g."loanId"
WHERE g.status = 'ACCEPTED'
GROUP BY g."tenantId";

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_guarantor_network_tenant
  ON mv_guarantor_network_density ("tenantId");

-- ─────────────────────────────────────────────────────────────────────────────
-- Refresh Function – called by BullMQ analytics processor
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION refresh_analytics_views()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_member_liquidity;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_loan_pipeline_velocity;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_deposit_inflow;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_guarantor_network_density;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- Time-Series Partitioning (PostgreSQL 15 declarative partitioning)
-- Applied to Transaction, AuditLog, MpesaCallbackLog
-- ─────────────────────────────────────────────────────────────────────────────

-- Partition creation function (called by monthly cron job)
CREATE OR REPLACE FUNCTION create_monthly_partitions(
  table_name TEXT,
  months_ahead INT DEFAULT 3
)
RETURNS void AS $$
DECLARE
  partition_date DATE;
  partition_name TEXT;
  start_date TEXT;
  end_date TEXT;
BEGIN
  FOR i IN 0..months_ahead LOOP
    partition_date := DATE_TRUNC('month', NOW() + (i || ' months')::INTERVAL);
    partition_name := table_name || '_' || TO_CHAR(partition_date, 'YYYY_MM');
    start_date := TO_CHAR(partition_date, 'YYYY-MM-DD');
    end_date := TO_CHAR(partition_date + INTERVAL '1 month', 'YYYY-MM-DD');

    -- Create partition if it doesn't exist
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      partition_name, table_name, start_date, end_date
    );

    RAISE NOTICE 'Ensured partition: %', partition_name;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- Performance Indexes for Phase 6 queries
-- ─────────────────────────────────────────────────────────────────────────────

-- Risk score lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_risk_score_tenant_member_ctx
  ON "RiskScore" ("tenantId", "memberId", context, "evaluatedAt" DESC);

-- Feature snapshot lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_feature_snapshot_tenant_version
  ON "FeatureSnapshot" ("tenantId", version, "exportedAt" DESC);

-- Compliance alert lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_compliance_alert_tenant_severity
  ON "ComplianceAlert" ("tenantId", severity, status, "createdAt" DESC);

-- Canary deployment lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_canary_deployment_status_started
  ON "CanaryDeployment" (status, "startedAt" DESC);

-- AuditLog chain verification (chronological walk)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_tenant_timestamp_chain
  ON "AuditLog" ("tenantId", "timestamp" ASC, "entryHash");

COMMENT ON MATERIALIZED VIEW mv_member_liquidity IS 'Phase 6: Per-tenant liquid asset position. Refresh via refresh_analytics_views().';
COMMENT ON MATERIALIZED VIEW mv_loan_pipeline_velocity IS 'Phase 6: Loan application throughput and approval rates. Refresh via refresh_analytics_views().';
COMMENT ON MATERIALIZED VIEW mv_daily_deposit_inflow IS 'Phase 6: Daily deposit activity (90-day rolling window). Refresh via refresh_analytics_views().';
COMMENT ON MATERIALIZED VIEW mv_guarantor_network_density IS 'Phase 6: Guarantor relationship density for ring detection. Refresh via refresh_analytics_views().';
