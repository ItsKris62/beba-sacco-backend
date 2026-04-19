-- CreateEnum
CREATE TYPE "public"."KycStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "public"."Member" ADD COLUMN     "kycRejectionReason" TEXT,
ADD COLUMN     "kycReviewedAt" TIMESTAMP(3),
ADD COLUMN     "kycReviewedByUserId" TEXT,
ADD COLUMN     "kycStatus" "public"."KycStatus" NOT NULL DEFAULT 'PENDING_REVIEW';

-- CreateIndex
CREATE INDEX "Member_tenantId_kycStatus_idx" ON "public"."Member"("tenantId", "kycStatus");
