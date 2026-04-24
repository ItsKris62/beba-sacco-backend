process.env.DATABASE_URL = process.env.DATABASE_URL || require('fs').readFileSync('.env','utf8').match(/DATABASE_URL="([^"]+)"/)?.[1];
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
let bcrypt; try { bcrypt = require('bcrypt'); } catch(e) { try { bcrypt = require('bcryptjs'); } catch(e2) { bcrypt = null; } }
async function hp(pw) { if (bcrypt) return bcrypt.hash(pw, 10); const c = require('crypto'); return '$2b$10$devplaceholder' + c.createHash('sha256').update(pw).digest('hex').slice(0,36); }
async function run() {
  const t = await p.tenant.upsert({ where:{slug:'beba-sacco'}, update:{status:'ACTIVE'}, create:{name:'Beba SACCO',slug:'beba-sacco',schemaName:'tenant_beba_sacco',status:'ACTIVE',contactEmail:'admin@beba-sacco.com',contactPhone:'+254700000000',address:'Nairobi, Kenya',settings:{}} });
  console.log('Tenant ID:', t.id);
  const ah = await hp('Admin@1234');
  await p.user.upsert({ where:{email:'admin@beba-sacco.com'}, update:{}, create:{tenantId:t.id,email:'admin@beba-sacco.com',passwordHash:ah,firstName:'Beba',lastName:'Admin',phone:'+254700000001',role:'MANAGER',isActive:true,emailVerified:true} });
  const mh = await hp('Member@1234');
  const mu = await p.user.upsert({ where:{email:'member@beba-sacco.com'}, update:{}, create:{tenantId:t.id,email:'member@beba-sacco.com',passwordHash:mh,firstName:'John',lastName:'Kamau',phone:'+254712345678',role:'MEMBER',isActive:true,emailVerified:true} });
  const mem = await p.member.upsert({ where:{userId:mu.id}, update:{}, create:{tenantId:t.id,userId:mu.id,memberNumber:'M-000001',nationalId:'12345678',kraPin:'A001234567B',employer:'Nairobi County',occupation:'Civil Servant',dateOfBirth:new Date('1985-06-15'),isActive:true,joinedAt:new Date('2024-01-01')} });
  await p.account.upsert({ where:{tenantId_accountNumber:{tenantId:t.id,accountNumber:'ACC-FOSA-000001'}}, update:{}, create:{tenantId:t.id,memberId:mem.id,accountNumber:'ACC-FOSA-000001',accountType:'FOSA',balance:50000,isActive:true} });
  await p.account.upsert({ where:{tenantId_accountNumber:{tenantId:t.id,accountNumber:'ACC-BOSA-000001'}}, update:{}, create:{tenantId:t.id,memberId:mem.id,accountNumber:'ACC-BOSA-000001',accountType:'BOSA',balance:120000,isActive:true} });
  await p.loanProduct.upsert({ where:{tenantId_name:{tenantId:t.id,name:'Development Loan'}}, update:{}, create:{tenantId:t.id,name:'Development Loan',description:'General development loan',minAmount:10000,maxAmount:500000,interestRate:0.12,interestType:'REDUCING_BALANCE',maxTenureMonths:36,processingFeeRate:0.01,gracePeriodMonths:1,isActive:true} });
  await p.loanProduct.upsert({ where:{tenantId_name:{tenantId:t.id,name:'Jipange Loan'}}, update:{}, create:{tenantId:t.id,name:'Jipange Loan',description:'Short-term emergency loan',minAmount:5000,maxAmount:100000,interestRate:0.15,interestType:'FLAT',maxTenureMonths:12,processingFeeRate:0.02,gracePeriodMonths:0,isActive:true} });
  await p.tenantCounter.upsert({ where:{tenantId:t.id}, update:{}, create:{tenantId:t.id,memberSeq:1,accountSeq:2,loanSeq:0} });
  console.log('DONE. NEXT_PUBLIC_TENANT_ID=' + t.id);
  console.log('admin@beba-sacco.com / Admin@1234 (MANAGER)');
  console.log('member@beba-sacco.com / Member@1234 (MEMBER)');
  await p.$disconnect();
}
run().catch(async e => { console.error('FAILED:', e.message); await p.$disconnect(); process.exit(1); });
