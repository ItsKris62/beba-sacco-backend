-- Tier 4: speed up tenant-scoped reconciliation review queues.
CREATE INDEX IF NOT EXISTS "Transaction_tenantId_status_createdAt_idx"
ON "public"."Transaction"("tenantId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "MpesaTransaction_tenantId_status_createdAt_idx"
ON "public"."MpesaTransaction"("tenantId", "status", "createdAt");
