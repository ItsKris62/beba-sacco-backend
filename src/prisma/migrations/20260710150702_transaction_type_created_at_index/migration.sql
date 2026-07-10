-- AlterTable
ALTER TABLE "public"."NotificationLog" ADD COLUMN     "eventType" TEXT NOT NULL DEFAULT 'legacy.notification',
ADD COLUMN     "providerResponse" JSONB,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "public"."NotificationPreference" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationPreference_tenantId_idx" ON "public"."NotificationPreference"("tenantId");

-- CreateIndex
CREATE INDEX "NotificationPreference_userId_idx" ON "public"."NotificationPreference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_tenantId_userId_key" ON "public"."NotificationPreference"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "NotificationLog_tenantId_eventType_idx" ON "public"."NotificationLog"("tenantId", "eventType");

-- CreateIndex
CREATE INDEX "NotificationLog_tenantId_status_createdAt_idx" ON "public"."NotificationLog"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_tenantId_type_createdAt_idx" ON "public"."Transaction"("tenantId", "type", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
