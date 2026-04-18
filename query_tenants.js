const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.tenant.findMany({
  select: { id: true, name: true, slug: true, status: true },
  take: 10
}).then(rows => {
  console.log(JSON.stringify(rows, null, 2));
  return p.$disconnect();
}).catch(e => {
  console.error(e.message);
  return p.$disconnect();
});
