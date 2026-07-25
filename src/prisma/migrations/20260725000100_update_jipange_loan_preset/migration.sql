UPDATE "public"."LoanProduct"
SET
  "maxAmount" = 50000.0000,
  "interestRate" = 0.0600,
  "interestType" = 'REDUCING_BALANCE',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE
  "name" = 'Jipange Loan'
  AND "maxAmount" = 200000.0000
  AND "interestRate" = 0.1500
  AND "interestType" = 'REDUCING_BALANCE';
