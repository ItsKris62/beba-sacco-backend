import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const txId = 'af483d62-a55b-4037-b9f5-596fb2098c8a';

  console.log('--- Transaction ---');
  const tx = await prisma.transaction.findUnique({ where: { id: txId } });
  console.log(tx);

  console.log('\n--- MpesaPayoutIntent ---');
  const intent = await prisma.mpesaPayoutIntent.findFirst({
    where: { OR: [{ sourceTransactionId: txId }, { referenceId: txId }] },
  });
  console.log(intent);

  console.log('\n--- IntegrationOutbox ---');
  const outbox = await prisma.integrationOutbox.findFirst({
    where: { entityId: txId },
  });
  console.log(outbox);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
