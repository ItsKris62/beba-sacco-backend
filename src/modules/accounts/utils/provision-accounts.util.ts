import { Prisma, AccountType } from '@prisma/client';

type PrismaTx = Prisma.TransactionClient;

export interface ProvisionResult {
  created: AccountType[];
  skipped: AccountType[];
}

/**
 * Idempotently provision FOSA + BOSA accounts for a member.
 *
 * Pure function (no NestJS DI) — accepts a Prisma transaction client so it
 * can run inside the caller's existing $transaction block.  Safe to call
 * multiple times for the same member; existing active accounts are skipped.
 *
 * Snapshots `minimumBalance` and `allowsNegative` from the tenant's
 * AccountTypePolicy (falls back to schema defaults when no policy exists).
 */
export async function provisionMemberAccounts(
  tx: PrismaTx,
  tenantId: string,
  memberId: string,
): Promise<ProvisionResult> {
  const REQUIRED_TYPES: AccountType[] = [AccountType.FOSA, AccountType.BOSA];

  // 1. Check which account types already exist (idempotent)
  const existing = await tx.account.findMany({
    where: {
      tenantId,
      memberId,
      accountType: { in: REQUIRED_TYPES },
      isActive: true,
    },
    select: { accountType: true },
  });
  const existingTypes = new Set(existing.map((a) => a.accountType));
  const missingTypes = REQUIRED_TYPES.filter((t) => !existingTypes.has(t));

  if (missingTypes.length === 0) {
    return { created: [], skipped: [...REQUIRED_TYPES] };
  }

  // 2. Fetch AccountTypePolicy for the missing types (snapshot at creation time)
  const policies = await tx.accountTypePolicy.findMany({
    where: { tenantId, accountType: { in: missingTypes } },
    select: { accountType: true, minimumBalance: true, allowsNegative: true },
  });
  const policyMap = new Map(policies.map((p) => [p.accountType, p]));

  // 3. Atomically claim sequential account numbers
  const counter = await tx.tenantCounter.upsert({
    where: { tenantId },
    update: { accountSeq: { increment: missingTypes.length } },
    create: { tenantId, memberSeq: 0, accountSeq: missingTypes.length, loanSeq: 0 },
    select: { accountSeq: true },
  });
  const firstSeq = counter.accountSeq - missingTypes.length + 1;

  // 4. Create the missing accounts
  for (const [index, accountType] of missingTypes.entries()) {
    const policy = policyMap.get(accountType);
    await tx.account.create({
      data: {
        tenantId,
        memberId,
        accountNumber: `ACC-${accountType}-${String(firstSeq + index).padStart(6, '0')}`,
        accountType,
        minimumBalance: policy?.minimumBalance ?? 0,
        allowsNegative: policy?.allowsNegative ?? false,
      },
    });
  }

  return {
    created: missingTypes,
    skipped: REQUIRED_TYPES.filter((t) => existingTypes.has(t)),
  };
}
