import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditPersistJobPayload } from '../queue/queue.constants';

const GENESIS_HASH = 'GENESIS';

interface ChainHeadRow {
  tenantId: string;
  lastHash: string;
  sequence: bigint;
}

@Injectable()
export class AuditChainService {
  private readonly logger = new Logger(AuditChainService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async persistEvent(payload: AuditPersistJobPayload): Promise<{ eventHash: string }> {
    const timestamp = payload.timestamp ? new Date(payload.timestamp) : new Date();
    const txClient = this.prisma.direct ?? this.prisma;

    return txClient.$transaction(
      async (tx) => {
        const head = await this.lockChainHead(tx, payload.tenantId);
        const prevHash = head.lastHash || GENESIS_HASH;
        const serializedPayload = this.canonicalJson({
          correlationId: payload.correlationId,
          tenantId: payload.tenantId,
          userId: payload.userId ?? null,
          role: payload.role ?? null,
          action: payload.action,
          resourceType: payload.resourceType ?? null,
          resourceId: payload.resourceId ?? null,
          oldState: payload.oldState ?? null,
          newState: payload.newState ?? null,
          metadata: payload.metadata ?? null,
          ip: payload.ip ?? null,
          userAgent: payload.userAgent ?? null,
          endpoint: payload.endpoint ?? null,
          method: payload.method ?? null,
          statusCode: payload.statusCode,
          success: payload.success,
          errorCode: payload.errorCode ?? null,
        });
        const eventHash = createHash('sha256')
          .update(`${prevHash}|${serializedPayload}|${timestamp.toISOString()}`, 'utf8')
          .digest('hex');
        const signature = this.sign(payload.tenantId, eventHash);

        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "AuditEvent" (
            id,
            "correlationId",
            timestamp,
            "tenantId",
            "userId",
            role,
            action,
            "resourceType",
            "resourceId",
            "oldState",
            "newState",
            metadata,
            ip,
            "userAgent",
            endpoint,
            method,
            "statusCode",
            success,
            "errorCode",
            "prevHash",
            "eventHash",
            signature
          ) VALUES (
            ${uuidv4()},
            ${payload.correlationId},
            ${timestamp},
            ${payload.tenantId},
            ${payload.userId ?? null},
            ${payload.role ?? null},
            ${payload.action},
            ${payload.resourceType ?? null},
            ${payload.resourceId ?? null},
            ${this.toJson(payload.oldState)}::jsonb,
            ${this.toJson(payload.newState)}::jsonb,
            ${this.toJson(payload.metadata)}::jsonb,
            ${payload.ip ?? null},
            ${payload.userAgent ?? null},
            ${payload.endpoint ?? null},
            ${payload.method ?? null},
            ${payload.statusCode},
            ${payload.success},
            ${payload.errorCode ?? null},
            ${prevHash},
            ${eventHash},
            ${signature}
          )
          ON CONFLICT ("tenantId", "eventHash") DO NOTHING
        `);

        await tx.$executeRaw(Prisma.sql`
          UPDATE "AuditChainHead"
          SET "lastHash" = ${eventHash}, sequence = ${head.sequence + BigInt(1)}, "updatedAt" = NOW()
          WHERE "tenantId" = ${payload.tenantId}
        `);

        return { eventHash };
      },
      { isolationLevel: 'Serializable' },
    );
  }

  async verifyTenantChain(tenantId: string): Promise<{ valid: boolean; failedAt?: string }> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        timestamp: Date;
        tenantId: string;
        correlationId: string;
        userId: string | null;
        role: string | null;
        action: string;
        resourceType: string | null;
        resourceId: string | null;
        oldState: Prisma.JsonValue | null;
        newState: Prisma.JsonValue | null;
        metadata: Prisma.JsonValue | null;
        ip: string | null;
        userAgent: string | null;
        endpoint: string | null;
        method: string | null;
        statusCode: number;
        success: boolean;
        errorCode: string | null;
        prevHash: string;
        eventHash: string;
        signature: string;
      }>
    >(Prisma.sql`
      SELECT *
      FROM "AuditEvent"
      WHERE "tenantId" = ${tenantId}
      ORDER BY timestamp ASC, id ASC
    `);

    let previous = GENESIS_HASH;
    for (const row of rows) {
      if (row.prevHash !== previous) {
        return { valid: false, failedAt: row.id };
      }

      const serializedPayload = this.canonicalJson({
        correlationId: row.correlationId,
        tenantId: row.tenantId,
        userId: row.userId,
        role: row.role,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        oldState: row.oldState,
        newState: row.newState,
        metadata: row.metadata,
        ip: row.ip,
        userAgent: row.userAgent,
        endpoint: row.endpoint,
        method: row.method,
        statusCode: row.statusCode,
        success: row.success,
        errorCode: row.errorCode,
      });
      const expectedHash = createHash('sha256')
        .update(`${row.prevHash}|${serializedPayload}|${row.timestamp.toISOString()}`, 'utf8')
        .digest('hex');

      if (expectedHash !== row.eventHash || !this.verifySignature(row.tenantId, row.eventHash, row.signature)) {
        return { valid: false, failedAt: row.id };
      }
      previous = row.eventHash;
    }

    return { valid: true };
  }

  private async lockChainHead(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<ChainHeadRow> {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "AuditChainHead" ("tenantId", "lastHash", sequence, "updatedAt")
      VALUES (${tenantId}, ${GENESIS_HASH}, 0, NOW())
      ON CONFLICT ("tenantId") DO NOTHING
    `);

    const rows = await tx.$queryRaw<ChainHeadRow[]>(Prisma.sql`
      SELECT "tenantId", "lastHash", sequence
      FROM "AuditChainHead"
      WHERE "tenantId" = ${tenantId}
      FOR UPDATE
    `);

    const head = rows[0];
    if (!head) {
      throw new Error(`Audit chain head missing for tenant ${tenantId}`);
    }
    return head;
  }

  private sign(tenantId: string, eventHash: string): string {
    return createHmac('sha256', this.getTenantSecret(tenantId)).update(eventHash).digest('hex');
  }

  private verifySignature(tenantId: string, eventHash: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(tenantId, eventHash), 'hex');
    const actual = Buffer.from(signature, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private getTenantSecret(tenantId: string): string {
    const secret = this.config.get<string>('app.audit.hmacSecret');
    if (!secret) {
      this.logger.warn('AUDIT_HMAC_SECRET is not set; using tenantId fallback for non-production only.');
      return tenantId;
    }
    return `${tenantId}:${secret}`;
  }

  private canonicalJson(value: unknown): string {
    if (value === null || value === undefined) {
      return 'null';
    }
    if (typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.canonicalJson(item)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${this.canonicalJson(record[key])}`)
      .join(',')}}`;
  }

  private toJson(value: unknown): string {
    return JSON.stringify(value ?? null);
  }
}
