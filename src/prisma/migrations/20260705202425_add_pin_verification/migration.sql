-- CreateEnum
CREATE TYPE "public"."PinPurpose" AS ENUM ('FIRST_LOGIN', 'PASSWORD_RESET');

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pinLoginRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "public"."PinVerification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "public"."PinPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "length" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requestedByIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PinVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PinVerification_userId_purpose_idx" ON "public"."PinVerification"("userId", "purpose");

-- CreateIndex
CREATE INDEX "PinVerification_tenantId_expiresAt_idx" ON "public"."PinVerification"("tenantId", "expiresAt");

-- CreateIndex
CREATE INDEX "User_phone_idx" ON "public"."User"("phone");

-- AddForeignKey
ALTER TABLE "public"."PinVerification" ADD CONSTRAINT "PinVerification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PinVerification" ADD CONSTRAINT "PinVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
