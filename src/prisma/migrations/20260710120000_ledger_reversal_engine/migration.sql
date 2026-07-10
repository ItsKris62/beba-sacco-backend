-- AlterEnum
ALTER TYPE "public"."TransactionType" ADD VALUE 'REVERSAL';

-- AlterEnum
ALTER TYPE "public"."JournalEntryType" ADD VALUE 'REVERSAL';

-- AlterTable
ALTER TABLE "public"."JournalEntry" ADD COLUMN     "reversalOfJournalEntryId" TEXT;

-- CreateIndex
CREATE INDEX "JournalEntry_reversalOfJournalEntryId_idx" ON "public"."JournalEntry"("reversalOfJournalEntryId");

-- AddForeignKey
ALTER TABLE "public"."JournalEntry" ADD CONSTRAINT "JournalEntry_reversalOfJournalEntryId_fkey" FOREIGN KEY ("reversalOfJournalEntryId") REFERENCES "public"."JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
