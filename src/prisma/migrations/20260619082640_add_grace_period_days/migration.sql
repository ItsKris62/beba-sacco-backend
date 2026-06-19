-- DropForeignKey
ALTER TABLE "public"."AuditChainHead" DROP CONSTRAINT "AuditChainHead_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "public"."AuditEvent" DROP CONSTRAINT "AuditEvent_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "public"."audit_archive_manifests" DROP CONSTRAINT "audit_archive_manifests_tenantId_fkey";

-- AlterTable
ALTER TABLE "public"."AuditChainHead" ALTER COLUMN "lastHash" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."AuditEvent" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "timestamp" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."LoanProduct" ADD COLUMN     "gracePeriodDays" INTEGER NOT NULL DEFAULT 14;

-- AlterTable
ALTER TABLE "public"."audit_archive_manifests" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "cutoffAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "rowCount" DROP DEFAULT,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "public"."AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditChainHead" ADD CONSTRAINT "AuditChainHead_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."audit_archive_manifests" ADD CONSTRAINT "audit_archive_manifests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "public"."Document_uploadToken_validation_idx" RENAME TO "Document_uploadToken_uploadTokenExpires_status_idx";

-- RenameIndex
ALTER INDEX "public"."audit_archive_manifests_tenant_cutoff_idx" RENAME TO "audit_archive_manifests_tenantId_cutoffAt_idx";
