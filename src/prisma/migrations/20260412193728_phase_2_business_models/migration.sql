-- CreateEnum
CREATE TYPE "public"."InterestType" AS ENUM ('FLAT', 'REDUCING_BALANCE');

-- DropEnum
DROP TYPE "public"."GuarantorStatus";

-- CreateTable
CREATE TABLE "public"."TenantCounter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberSeq" INTEGER NOT NULL DEFAULT 0,
    "accountSeq" INTEGER NOT NULL DEFAULT 0,
    "loanSeq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TenantCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Member" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "memberNumber" TEXT NOT NULL,
    "nationalId" TEXT,
    "kraPin" TEXT,
    "employer" TEXT,
    "occupation" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Account" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountType" "public"."AccountType" NOT NULL,
    "balance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LoanProduct" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "minAmount" DECIMAL(18,4) NOT NULL,
    "maxAmount" DECIMAL(18,4) NOT NULL,
    "interestRate" DECIMAL(7,4) NOT NULL,
    "interestType" "public"."InterestType" NOT NULL DEFAULT 'REDUCING_BALANCE',
    "maxTenureMonths" INTEGER NOT NULL,
    "processingFeeRate" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Loan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "loanProductId" TEXT NOT NULL,
    "loanNumber" TEXT NOT NULL,
    "status" "public"."LoanStatus" NOT NULL DEFAULT 'DRAFT',
    "principalAmount" DECIMAL(18,4) NOT NULL,
    "interestRate" DECIMAL(7,4) NOT NULL,
    "processingFee" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "tenureMonths" INTEGER NOT NULL,
    "monthlyInstalment" DECIMAL(18,4) NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "disbursedAt" TIMESTAMP(3),
    "disbursedBy" TEXT,
    "dueDate" TIMESTAMP(3),
    "totalRepaid" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "outstandingBalance" DECIMAL(18,4) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Transaction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "loanId" TEXT,
    "type" "public"."TransactionType" NOT NULL,
    "status" "public"."TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(18,4) NOT NULL,
    "balanceBefore" DECIMAL(18,4) NOT NULL,
    "balanceAfter" DECIMAL(18,4) NOT NULL,
    "reference" TEXT NOT NULL,
    "description" TEXT,
    "processedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MpesaTransaction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "transactionId" TEXT,
    "checkoutRequestId" TEXT NOT NULL,
    "merchantRequestId" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "status" "public"."TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "resultCode" INTEGER,
    "resultDesc" TEXT,
    "mpesaReceiptNumber" TEXT,
    "callbackPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MpesaTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantCounter_tenantId_key" ON "public"."TenantCounter"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_userId_key" ON "public"."Member"("userId");

-- CreateIndex
CREATE INDEX "Member_tenantId_idx" ON "public"."Member"("tenantId");

-- CreateIndex
CREATE INDEX "Member_tenantId_isActive_idx" ON "public"."Member"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Member_tenantId_memberNumber_key" ON "public"."Member"("tenantId", "memberNumber");

-- CreateIndex
CREATE INDEX "Account_tenantId_memberId_idx" ON "public"."Account"("tenantId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_tenantId_accountNumber_key" ON "public"."Account"("tenantId", "accountNumber");

-- CreateIndex
CREATE INDEX "LoanProduct_tenantId_isActive_idx" ON "public"."LoanProduct"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "LoanProduct_tenantId_name_key" ON "public"."LoanProduct"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Loan_tenantId_memberId_idx" ON "public"."Loan"("tenantId", "memberId");

-- CreateIndex
CREATE INDEX "Loan_tenantId_status_idx" ON "public"."Loan"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Loan_tenantId_loanNumber_key" ON "public"."Loan"("tenantId", "loanNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_reference_key" ON "public"."Transaction"("reference");

-- CreateIndex
CREATE INDEX "Transaction_tenantId_accountId_idx" ON "public"."Transaction"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "Transaction_tenantId_loanId_idx" ON "public"."Transaction"("tenantId", "loanId");

-- CreateIndex
CREATE INDEX "Transaction_reference_idx" ON "public"."Transaction"("reference");

-- CreateIndex
CREATE INDEX "Transaction_createdAt_idx" ON "public"."Transaction"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MpesaTransaction_transactionId_key" ON "public"."MpesaTransaction"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "MpesaTransaction_checkoutRequestId_key" ON "public"."MpesaTransaction"("checkoutRequestId");

-- CreateIndex
CREATE INDEX "MpesaTransaction_tenantId_idx" ON "public"."MpesaTransaction"("tenantId");

-- CreateIndex
CREATE INDEX "MpesaTransaction_checkoutRequestId_idx" ON "public"."MpesaTransaction"("checkoutRequestId");

-- AddForeignKey
ALTER TABLE "public"."TenantCounter" ADD CONSTRAINT "TenantCounter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Member" ADD CONSTRAINT "Member_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Member" ADD CONSTRAINT "Member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Account" ADD CONSTRAINT "Account_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Account" ADD CONSTRAINT "Account_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "public"."Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LoanProduct" ADD CONSTRAINT "LoanProduct_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Loan" ADD CONSTRAINT "Loan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Loan" ADD CONSTRAINT "Loan_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "public"."Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Loan" ADD CONSTRAINT "Loan_loanProductId_fkey" FOREIGN KEY ("loanProductId") REFERENCES "public"."LoanProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Transaction" ADD CONSTRAINT "Transaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Transaction" ADD CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Transaction" ADD CONSTRAINT "Transaction_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "public"."Loan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MpesaTransaction" ADD CONSTRAINT "MpesaTransaction_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
