import { readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { randomInt } from 'crypto';
import * as argon2 from 'argon2';
import { PrismaClient, UserRole, AccountStatus, StagePosition } from '@prisma/client';
import { Queue } from 'bullmq';
import { CsvParserService } from '../../modules/data-import/csv-parser.service';
import { generateImportEmail } from '../../modules/data-import/utils/name-parser';
import { QUEUE_NAMES, SmsJobPayload } from '../../modules/queue/queue.constants';
import type { ParsedCsvRow } from '../../modules/data-import/dto/import.dto';

type Args = {
  file?: string;
  tenantId?: string;
  wardId?: string;
  actorId?: string;
  dryRun: boolean;
  execute: boolean;
  sample: number;
};

type PlannedRow = ParsedCsvRow & {
  tempPassword: string;
  email: string;
  memberNumber: string;
  errors: string[];
  skipReason?: string;
  action: 'CREATE' | 'SKIP';
};

const prisma = new PrismaClient();
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const DEFAULT_SAMPLE_SIZE = 8;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertArgs(args);

  const filePath = isAbsolute(args.file!) ? args.file! : resolve(process.cwd(), args.file!);
  const tenant = await prisma.tenant.findUnique({
    where: { id: args.tenantId! },
    select: { id: true, name: true },
  });
  if (!tenant) throw new Error(`Tenant not found: ${args.tenantId}`);

  const ward = await prisma.ward.findUnique({
    where: { id: args.wardId! },
    select: {
      id: true,
      name: true,
      constituency: { select: { name: true, county: { select: { name: true } } } },
    },
  });
  if (!ward) throw new Error(`Ward not found: ${args.wardId}`);

  const parser = new CsvParserService();
  const rows = await parser.parseBuffer(readFileSync(filePath));
  const planned = await buildPlan(rows, args.tenantId!);
  const errors = planned.flatMap((row) =>
    row.errors.map((reason) => ({ row: row.rowNumber, name: fullName(row), reason })),
  );
  const processable = planned.filter((row) => row.action === 'CREATE');

  printPreview({
    filePath,
    tenant,
    ward,
    planned,
    errors,
    sample: args.sample,
    dryRun: args.dryRun,
  });

  if (args.dryRun) return;
  if (!args.execute) {
    throw new Error('Refusing to write data without --execute. Run with --dry-run first, then add --execute for final import.');
  }
  if (errors.length > 0) {
    throw new Error(`Refusing final import because ${errors.length} validation error(s) remain.`);
  }

  const batchId = cryptoRandomId();
  const smsQueue = createSmsQueue();

  try {
    let successCount = 0;
    for (const row of processable) {
      await createMemberUser({
        row,
        tenantId: args.tenantId!,
        wardId: args.wardId!,
        actorId: args.actorId,
        batchId,
        smsQueue,
      });
      successCount++;
    }
    console.log(`Final import complete: ${successCount}/${processable.length} member users created; SMS jobs queued.`);
  } finally {
    await smsQueue.close();
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, execute: false, sample: DEFAULT_SAMPLE_SIZE };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--dry-run') args.dryRun = true;
    else if (item === '--execute') args.execute = true;
    else if (item === '--file') args.file = argv[++i];
    else if (item === '--tenantId') args.tenantId = argv[++i];
    else if (item === '--wardId') args.wardId = argv[++i];
    else if (item === '--actorId') args.actorId = argv[++i];
    else if (item === '--sample') args.sample = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${item}`);
  }
  return args;
}

function assertArgs(args: Args) {
  if (!args.file) throw new Error('--file is required');
  if (!args.tenantId || args.tenantId.includes('<')) throw new Error('--tenantId must be a real tenant UUID');
  if (!args.wardId || args.wardId.includes('<')) throw new Error('--wardId must be a real ward ID');
  if (!Number.isInteger(args.sample) || args.sample < 1 || args.sample > 25) {
    throw new Error('--sample must be an integer between 1 and 25');
  }
}

async function buildPlan(rows: ParsedCsvRow[], tenantId: string): Promise<PlannedRow[]> {
  const existingUsers = await prisma.user.findMany({
    where: {
      OR: [
        { idNumber: { in: rows.map((row) => row.idNumber).filter(isString) } },
        { phoneNumber: { in: rows.map((row) => row.phoneNumber).filter(isString) } },
      ],
    },
    select: {
      idNumber: true,
      phoneNumber: true,
      tenantId: true,
      role: true,
      member: { select: { id: true } },
    },
  });
  const existingMembers = await prisma.member.findMany({
    where: {
      tenantId,
      nationalId: { in: rows.map((row) => row.idNumber).filter(isString) },
    },
    select: { nationalId: true },
  });

  const existingIds = new Set(existingUsers.map((user) => user.idNumber).filter(isString));
  const existingPhones = new Set(existingUsers.map((user) => user.phoneNumber).filter(isString));
  const existingMemberIds = new Set(existingMembers.map((member) => member.nationalId).filter(isString));
  const seenIds = new Set<string>();
  const seenPhones = new Set<string>();
  const previewMemberNumbers = new Set<string>();

  return rows.map((row) => {
    const errors: string[] = [];
    const alreadyImported = existingUsers.some(
      (user) =>
        user.tenantId === tenantId &&
        user.role === UserRole.MEMBER &&
        Boolean(user.member) &&
        ((row.idNumber && user.idNumber === row.idNumber) ||
          (row.phoneNumber && user.phoneNumber === row.phoneNumber)),
    );

    if (!row.firstName || row.firstName === 'Unknown') errors.push('Invalid or missing name');
    if (!row.idNumber) errors.push('Invalid or missing national ID');
    if (!row.phoneNumber) errors.push('Invalid or missing phone number');
    if (row.idNumber && seenIds.has(row.idNumber)) errors.push('Duplicate national ID in CSV');
    if (row.phoneNumber && seenPhones.has(row.phoneNumber)) errors.push('Duplicate phone in CSV');
    if (!alreadyImported && row.idNumber && existingIds.has(row.idNumber)) errors.push('National ID already exists in User table');
    if (!alreadyImported && row.phoneNumber && existingPhones.has(row.phoneNumber)) errors.push('Phone already exists in User table');
    if (!alreadyImported && row.idNumber && existingMemberIds.has(row.idNumber)) errors.push('National ID already exists in Member table');

    if (row.idNumber) seenIds.add(row.idNumber);
    if (row.phoneNumber) seenPhones.add(row.phoneNumber);

    const tempPassword = generateTempPassword();
    return {
      ...row,
      tempPassword,
      email: generateImportEmail(row.firstName, row.lastName, row.phoneNumber ?? row.rawPhone ?? String(row.rowNumber)),
      memberNumber: generateMemberNumberPreview(previewMemberNumbers),
      errors,
      skipReason: alreadyImported ? 'Already imported' : undefined,
      action: errors.length > 0 || alreadyImported ? 'SKIP' : 'CREATE',
    };
  });
}

async function createMemberUser(params: {
  row: PlannedRow;
  tenantId: string;
  wardId: string;
  actorId?: string;
  batchId: string;
  smsQueue: Queue<SmsJobPayload>;
}) {
  const { row, tenantId, wardId, actorId, batchId, smsQueue } = params;
  const passwordHash = await argon2.hash(row.tempPassword, {
    type: argon2.argon2id,
    memoryCost: 32768,
    timeCost: 3,
    parallelism: 1,
  });

  const result = await prisma.$transaction(async (tx) => {
    const stage = await tx.stage.upsert({
      where: { name_wardId_tenantId: { name: 'UNASSIGNED', wardId, tenantId } },
      create: { name: 'UNASSIGNED', wardId, tenantId },
      update: {},
      select: { id: true },
    });

    const email = await uniqueEmail(row.email, row.rowNumber);
    const user = await tx.user.create({
      data: {
        tenantId,
        email,
        passwordHash,
        role: UserRole.MEMBER,
        firstName: row.firstName,
        lastName: row.lastName,
        phone: row.phoneNumber,
        phoneNumber: row.phoneNumber,
        idNumber: row.idNumber,
        legacyMemberNo: row.legacyNo ?? undefined,
        importBatchId: batchId,
        wardId,
        accountStatus: AccountStatus.ACTIVE,
        mustChangePassword: true,
        createdById: actorId,
        approvedById: actorId,
        approvedAt: new Date(),
        approvalReason: 'Imported from cleaned member CSV',
      },
      select: { id: true },
    });

    const member = await tx.member.create({
      data: {
        tenantId,
        userId: user.id,
        memberNumber: await uniqueMemberNumber(tx, row.memberNumber),
        nationalId: row.idNumber,
      },
      select: { id: true },
    });

    await tx.stageAssignment.upsert({
      where: { userId_stageId: { userId: user.id, stageId: stage.id } },
      create: { userId: user.id, stageId: stage.id, position: StagePosition.MEMBER, isActive: true },
      update: { position: StagePosition.MEMBER, isActive: true },
    });

    await tx.memberStage.upsert({
      where: { memberId_stageId: { memberId: member.id, stageId: stage.id } },
      create: { memberId: member.id, stageId: stage.id, assignedBy: actorId, isActive: true },
      update: { assignedBy: actorId, isActive: true },
    });

    return { userId: user.id };
  });

  await smsQueue.add(
    'send',
    {
      type: 'TEMP_PASSWORD',
      phone: row.phoneNumber!,
      message:
        `Welcome to Beba SACCO. Login with your phone number ${row.phoneNumber} ` +
        `and temporary password: ${row.tempPassword}. You will be required to change it immediately.`,
    },
    { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
  );

  return result;
}

async function uniqueEmail(baseEmail: string, rowNumber: number): Promise<string> {
  const existing = await prisma.user.findFirst({ where: { email: baseEmail }, select: { id: true } });
  if (!existing) return baseEmail;
  const [local, domain] = baseEmail.split('@');
  return `${local}.${rowNumber}.${Date.now()}@${domain}`;
}

async function uniqueMemberNumber(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], preferred: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? preferred : `MBR-${randomInt(100000, 1000000)}`;
    const existing = await tx.member.findFirst({ where: { memberNumber: candidate }, select: { id: true } });
    if (!existing) return candidate;
  }
  throw new Error('Could not generate a unique member number');
}

function createSmsQueue(): Queue<SmsJobPayload> {
  const bullUrl = process.env.BULL_REDIS_URL;
  if (bullUrl) {
    const parsed = new URL(bullUrl);
    return new Queue<SmsJobPayload>(QUEUE_NAMES.SMS, {
      connection: {
        host: parsed.hostname,
        port: Number(parsed.port || 6379),
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        tls: parsed.protocol === 'rediss:' ? { rejectUnauthorized: false } : undefined,
      },
    });
  }

  return new Queue<SmsJobPayload>(QUEUE_NAMES.SMS, {
    connection: {
      host: (process.env.REDIS_HOST || 'localhost').replace(/^https?:\/\//, ''),
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      tls: process.env.REDIS_TLS === 'true' ? { rejectUnauthorized: false } : undefined,
    },
  });
}

function printPreview(params: {
  filePath: string;
  tenant: { id: string; name: string };
  ward: { id: string; name: string; constituency: { name: string; county: { name: string } } };
  planned: PlannedRow[];
  errors: Array<{ row: number; name: string; reason: string }>;
  sample: number;
  dryRun: boolean;
}) {
  const { filePath, tenant, ward, planned, errors, sample, dryRun } = params;
  const processable = planned.filter((row) => row.action === 'CREATE');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'FINAL IMPORT'}`);
  console.log(`File: ${filePath}`);
  console.log(`Tenant: ${tenant.name} (${tenant.id})`);
  console.log(`Ward: ${ward.name}, ${ward.constituency.name}, ${ward.constituency.county.name} (${ward.id})`);
  console.log(`Rows parsed: ${planned.length}`);
  console.log(`Processable rows: ${processable.length}`);
  console.log(`Skipped existing rows: ${planned.filter((row) => row.skipReason).length}`);
  console.log(`Validation errors: ${errors.length}`);

  if (errors.length > 0) {
    console.table(errors.slice(0, 20));
    if (errors.length > 20) console.log(`...${errors.length - 20} more error(s)`);
  }

  console.log(dryRun ? 'Preview sample:' : 'Import sample:');
  console.table(
    planned.slice(0, sample).map((row) => ({
      row: row.rowNumber,
      name: fullName(row),
      idNumber: row.idNumber,
      phone: row.phoneNumber,
      role: 'MEMBER',
      memberNumber: row.memberNumber,
      stage: row.stageName ?? 'UNASSIGNED',
      mustChangePassword: true,
      tempPassword: dryRun ? row.tempPassword : '[hidden]',
      skipReason: row.skipReason ?? '',
      action: row.action,
    })),
  );
}

function generateTempPassword(length = 10): string {
  return Array.from({ length }, () => PASSWORD_ALPHABET[randomInt(0, PASSWORD_ALPHABET.length)]).join('');
}

function generateMemberNumberPreview(seen: Set<string>): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `MBR-${randomInt(100000, 1000000)}`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      return candidate;
    }
  }
  throw new Error('Could not generate preview member number');
}

function cryptoRandomId(): string {
  return `${Date.now().toString(36)}-${randomInt(100000, 1000000)}`;
}

function fullName(row: Pick<ParsedCsvRow, 'firstName' | 'lastName'>): string {
  return `${row.firstName} ${row.lastName}`.trim();
}

function isString(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
