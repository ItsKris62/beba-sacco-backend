/**
 * E2E test helper — creates a PENDING MpesaTransaction row exactly as
 * MpesaService.initiateDeposit() would (src/modules/mpesa/mpesa.service.ts:141-156),
 * without going through the real Safaricom Daraja STK-push call.
 *
 * Why this exists: the real deposit-initiation endpoint (POST
 * /members/deposit/mpesa) always calls the real Safaricom sandbox before
 * writing this row — there's no code path that creates it without a live
 * Daraja round trip. For local E2E runs we don't have (and don't want to
 * burn the 3-req/day-per-member rate limit on) a live Safaricom sandbox
 * call, so this script recreates just the DB side effect directly, using
 * a synthetic but uniquely-generated checkoutRequestId. The Playwright
 * spec mocks the browser-side POST to return that same id, then later
 * POSTs a real STK callback to the real backend referencing it — the
 * callback processor (mpesa-callback.processor.ts:136-138) looks the
 * transaction up by checkoutRequestId, so it needs to already exist.
 *
 * CLI-only, never exposed over HTTP. Not wired into any module/app.module.ts.
 *
 * Usage: ts-node -r tsconfig-paths/register scripts/e2e-create-pending-deposit.ts \
 *          --email=e2e-borrower@test.beba.local --amount=1000 --tenantSlug=e2e-test-sacco
 * Prints a single JSON line to stdout: {checkoutRequestId, merchantRequestId, accountReference, amount}
 */
import { PrismaClient, MpesaTxType, MpesaTriggerSource, TransactionStatus } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

function arg(name: string, fallback?: string): string {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = match?.slice(name.length + 3);
  if (!value && fallback === undefined) {
    throw new Error(`Missing required --${name} argument`);
  }
  return value ?? fallback!;
}

async function main() {
  const email = arg('email');
  const amount = Number(arg('amount'));
  const tenantSlug = arg('tenantSlug', 'e2e-test-sacco');
  const phoneNumber = arg('phone', '254712345678');

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid --amount: ${arg('amount')}`);
  }

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } });
  const user = await prisma.user.findUniqueOrThrow({
    where: { tenantId_email: { tenantId: tenant.id, email } },
    select: { id: true },
  });
  const member = await prisma.member.findUniqueOrThrow({
    where: { userId: user.id },
    select: { id: true },
  });
  const fosaAccount = await prisma.account.findFirstOrThrow({
    where: { memberId: member.id, tenantId: tenant.id, accountType: 'FOSA', isActive: true },
    select: { accountNumber: true },
  });

  const checkoutRequestId = `ws_CO_e2e_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const merchantRequestId = `E2E-MERCHANT-${randomUUID().slice(0, 8)}`;
  const reference = `STK-${checkoutRequestId}`;

  await prisma.mpesaTransaction.create({
    data: {
      tenantId: tenant.id,
      memberId: member.id,
      type: MpesaTxType.STK_PUSH,
      triggerSource: MpesaTriggerSource.MEMBER,
      checkoutRequestId,
      merchantRequestId,
      phoneNumber,
      amount: amount.toFixed(4),
      accountReference: fosaAccount.accountNumber,
      description: 'E2E test deposit',
      reference,
      status: TransactionStatus.PENDING,
    },
  });

  console.log(JSON.stringify({
    checkoutRequestId,
    merchantRequestId,
    accountReference: fosaAccount.accountNumber,
    amount,
  }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
