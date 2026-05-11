-- Part 2: All schema changes that depend on PENDING_UPLOAD being committed.

-- CreateEnum
CREATE TYPE "public"."DocumentStatus" AS ENUM ('PENDING_UPLOAD', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'DELETED');

-- CreateEnum
CREATE TYPE "public"."DocumentType" AS ENUM ('NATIONAL_ID_FRONT', 'NATIONAL_ID_BACK', 'KRA_PIN', 'MEMBER_FORM', 'OTHER');

-- AlterTable
ALTER TABLE "public"."Member" ALTER COLUMN "kycStatus" SET DEFAULT 'PENDING_UPLOAD';
ALTER TABLE "public"."Member" DROP COLUMN IF EXISTS "kycDocumentUrls";

-- CreateTable
CREATE TABLE "public"."Document" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT,
    "type" "public"."DocumentType" NOT NULL,
    "status" "public"."DocumentStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "version" INTEGER NOT NULL DEFAULT 1,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Document_tenantId_objectKey_key" ON "public"."Document"("tenantId", "objectKey");

-- CreateIndex
CREATE INDEX "Document_tenantId_memberId_status_idx" ON "public"."Document"("tenantId", "memberId", "status");

-- CreateIndex
CREATE INDEX "Document_tenantId_memberId_type_status_idx" ON "public"."Document"("tenantId", "memberId", "type", "status");

-- CreateIndex
CREATE INDEX "Document_status_expiresAt_idx" ON "public"."Document"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "public"."Document" ADD CONSTRAINT "Document_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Document" ADD CONSTRAINT "Document_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "public"."Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
