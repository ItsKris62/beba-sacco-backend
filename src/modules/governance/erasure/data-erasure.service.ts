/**
 * Phase 7 – Right-to-Be-Forgotten Automation
 * Anonymizes PII, preserves financial/audit records per SASRA/DPA retention.
 * Generates compliance certificate. Idempotent via memberId.
 */
import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import * as crypto from 'crypto';

export interface ErasureRequest {
  tenantId: string;
  memberId: string;
  reason: string;
  requestedBy: string;
}

export interface ErasureCertificate {
  certificateId: string;
  memberId: string;
  tenantId: string;
  requestedBy: string;
  reason: string;
  erasedFields: string[];
  preservedRecords: string[];
  completedAt: string;
  signature: string;
}

@Injectable()
export class DataErasureService {
  private readonly logger = new Logger(DataErasureService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.DATA_ERASURE) private readonly erasureQueue: Queue,
  ) {}

  /**
   * Queue a data erasure job. Idempotent – returns existing cert if already processed.
   */
  async queueErasure(req: ErasureRequest): Promise<{ jobId: string; certId: string }> {
    // Check for existing erasure
    const existing = await this.prisma.erasureRequest.findFirst({
      where: { tenantId: req.tenantId, memberId: req.memberId, status: { in: ['PENDING', 'COMPLETED'] } },
    });

    if (existing?.status === 'COMPLETED') {
      throw new ConflictException(`Member ${req.memberId} has already been erased. Certificate: ${existing.certificateId}`);
    }

    if (existing?.status === 'PENDING') {
      return { jobId: existing.jobId ?? 'queued', certId: existing.certificateId ?? '' };
    }

    const certId = `CERT-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

    const record = await this.prisma.erasureRequest.create({
      data: {
        tenantId: req.tenantId,
        memberId: req.memberId,
        reason: req.reason,
        requestedBy: req.requestedBy,
        status: 'PENDING',
        certificateId: certId,
      },
    });

    const job = await this.erasureQueue.add(
      'erase-member-data',
      {
        tenantId: req.tenantId,
        memberId: req.memberId,
        erasureRequestId: record.id,
        certId,
      },
      {
        jobId: `erasure-${req.memberId}-${Date.now()}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
      },
    );

    await this.prisma.erasureRequest.update({
      where: { id: record.id },
      data: { jobId: job.id },
    });

    this.logger.log(`[DataErasure] Queued erasure for member ${req.memberId}, cert=${certId}`);
    return { jobId: job.id ?? '', certId };
  }

  /**
   * Execute the actual erasure (called by queue processor).
   * Anonymizes PII fields, preserves financial/audit records.
   */
  async executeErasure(
    tenantId: string,
    memberId: string,
    erasureRequestId: string,
  ): Promise<ErasureCertificate> {
    this.logger.log(`[DataErasure] Executing erasure for member ${memberId}`);

    const erasedFields: string[] = [];
    const preservedRecords: string[] = [];

    // Anonymize Member PII fields
    const anonymizedId = `ANON-${crypto.randomBytes(6).toString('hex')}`;
    await this.prisma.member.update({
      where: { id: memberId },
      data: {
        nationalId: null,
        kraPin: null,
        employer: null,
        occupation: null,
        dateOfBirth: null,
        deletedAt: new Date(),
        isActive: false,
      },
    });
    erasedFields.push('nationalId', 'kraPin', 'employer', 'occupation', 'dateOfBirth');

    // Anonymize User PII
    await this.prisma.user.updateMany({
      where: { member: { id: memberId } },
      data: {
        firstName: anonymizedId,
        lastName: 'ERASED',
        phone: null,
        isActive: false,
      },
    });
    erasedFields.push('user.firstName', 'user.lastName', 'user.phone');

    // Preserve financial records (SASRA/DPA 7-year retention)
    const txCount = await this.prisma.transaction.count({ where: { tenantId } });
    preservedRecords.push(`${txCount} transactions (7-year retention)`);

    const loanCount = await this.prisma.loan.count({ where: { tenantId, memberId } });
    preservedRecords.push(`${loanCount} loan records (regulatory retention)`);

    // Anonymize DataAccessLog entries for this member
    await this.prisma.dataAccessLog.updateMany({
      where: { tenantId, entityId: memberId },
      data: { entityId: anonymizedId },
    });

    // Generate certificate
    const certData = {
      memberId,
      tenantId,
      erasedFields,
      preservedRecords,
      completedAt: new Date().toISOString(),
    };
    const signature = crypto
      .createHmac('sha256', process.env['ERASURE_SIGNING_KEY'] ?? 'beba-erasure-key')
      .update(JSON.stringify(certData))
      .digest('hex');

    const request = await this.prisma.erasureRequest.findUnique({ where: { id: erasureRequestId } });

    const certificate: ErasureCertificate = {
      certificateId: request?.certificateId ?? `CERT-${erasureRequestId}`,
      memberId: anonymizedId,
      tenantId,
      requestedBy: request?.requestedBy ?? 'SYSTEM',
      reason: request?.reason ?? 'DATA_ERASURE_REQUEST',
      erasedFields,
      preservedRecords,
      completedAt: certData.completedAt,
      signature,
    };

    // Mark erasure as completed
    await this.prisma.erasureRequest.update({
      where: { id: erasureRequestId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        certificate: certificate as unknown as Prisma.InputJsonValue,
      },
    });

    this.logger.log(`[DataErasure] Completed erasure for ${memberId}, cert=${certificate.certificateId}`);
    return certificate;
  }

  /**
   * Get erasure status and certificate for a member.
   */
  async getErasureStatus(tenantId: string, memberId: string): Promise<unknown> {
    return this.prisma.erasureRequest.findFirst({
      where: { tenantId, memberId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
