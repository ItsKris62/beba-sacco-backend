-- AlterTable
ALTER TABLE "public"."Member" ALTER COLUMN "kycStatus" SET DEFAULT 'PENDING_UPLOAD';

-- CreateTable
CREATE TABLE "public"."kyc_requirements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "kycStage" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kyc_requirements_tenantId_kycStage_idx" ON "public"."kyc_requirements"("tenantId", "kycStage");

-- CreateIndex
CREATE INDEX "kyc_requirements_tenantId_isRequired_idx" ON "public"."kyc_requirements"("tenantId", "isRequired");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_requirements_tenantId_documentType_kycStage_key" ON "public"."kyc_requirements"("tenantId", "documentType", "kycStage");

-- AddForeignKey
ALTER TABLE "public"."MpesaTransaction" ADD CONSTRAINT "MpesaTransaction_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "public"."Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."kyc_requirements" ADD CONSTRAINT "kyc_requirements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
