-- Manual, zero-downtime index build script.
-- IMPORTANT:
--   1. Do not run this through `prisma migrate deploy`.
--   2. Run each statement with autocommit enabled. PostgreSQL rejects
--      CREATE INDEX CONCURRENTLY inside a transaction block.
--   3. After all statements succeed, mark the corresponding Prisma migration
--      as applied only if you intentionally keep a Prisma migration record:
--      npx prisma migrate resolve --applied 20260622090000_add_scale_indexes --schema src/prisma/schema.prisma

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Loan_tenantId_loanProductId_idx"
  ON "public"."Loan" ("tenantId", "loanProductId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "MemberApplication_tenantId_wardId_idx"
  ON "public"."MemberApplication" ("tenantId", "wardId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "GLAccount_tenantId_parentId_idx"
  ON "public"."GLAccount" ("tenantId", "parentId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "JournalEntry_tenantId_createdById_idx"
  ON "public"."JournalEntry" ("tenantId", "createdById");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "JournalEntry_tenantId_approvedById_idx"
  ON "public"."JournalEntry" ("tenantId", "approvedById");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "JournalEntry_tenantId_rejectedById_idx"
  ON "public"."JournalEntry" ("tenantId", "rejectedById");
