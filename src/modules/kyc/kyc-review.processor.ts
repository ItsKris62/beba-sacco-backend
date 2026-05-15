import { Processor, WorkerHost, OnWorkerEvent, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { AccountType, DocumentStatus, DocumentType, KycStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { QUEUE_NAMES, EmailJobPayload } from '../queue/queue.constants';

export interface KycReviewJobPayload {
  docId: string;
  reviewerId: string;
  action: 'APPROVED' | 'REJECTED';
  tenantId: string;
  rejectionReason?: string;
}

// Fallback when no KYCRequirement rows are configured for the tenant
const DEFAULT_REQUIRED_TYPES: DocumentType[] = [
  DocumentType.NATIONAL_ID_FRONT,
  DocumentType.NATIONAL_ID_BACK,
  DocumentType.KRA_PIN,
  DocumentType.MEMBER_FORM,
];

@Processor(QUEUE_NAMES.KYC_REVIEW, { concurrency: 2 })
export class KycReviewProcessor extends WorkerHost {
  private readonly logger = new Logger(KycReviewProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_NAMES.KYC_REVIEW_DLQ)
    private readonly dlqQueue: Queue<KycReviewJobPayload>,
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue<EmailJobPayload>,
  ) {
    super();
  }

  async process(job: Job<KycReviewJobPayload>): Promise<void> {
    const { docId, reviewerId, action, tenantId, rejectionReason } = job.data;
    this.logger.log(`KYC review job ${job.id}: doc=${docId} action=${action}`);

    const document = await this.prisma.document.findFirst({
      where: { id: docId, tenantId, status: DocumentStatus.PENDING_REVIEW },
      include: {
        member: {
          select: {
            id: true,
            memberNumber: true,
            user: { select: { email: true, firstName: true } },
          },
        },
      },
    });

    if (!document) {
      this.logger.warn(
        `KYC review job ${job.id}: doc ${docId} not found or not PENDING_REVIEW — skipping`,
      );
      return;
    }

    const docStatus =
      action === 'APPROVED' ? DocumentStatus.APPROVED : DocumentStatus.REJECTED;

    await this.prisma.$transaction(async (tx) => {
      await tx.document.update({
        where: { id: docId },
        data: {
          status: docStatus,
          reviewedById: reviewerId,
          reviewedAt: new Date(),
          rejectionReason: action === 'REJECTED' ? (rejectionReason?.trim() ?? null) : null,
        },
      });

      const memberUpdate: Record<string, unknown> = {
        kycReviewedAt: new Date(),
        kycReviewedByUserId: reviewerId,
      };

      if (action === 'REJECTED') {
        memberUpdate.kycStatus = KycStatus.REJECTED;
        memberUpdate.kycRejectionReason = rejectionReason?.trim() ?? null;
      } else {
        // Determine required types from KYCRequirement table, fall back to defaults
        const configured = await tx.kycRequirement.findMany({
          where: { tenantId, isRequired: true },
          select: { documentType: true },
        });
        const requiredTypes = configured.length > 0
          ? configured.map((r) => r.documentType as DocumentType)
          : DEFAULT_REQUIRED_TYPES;

        const approvedCount = await tx.document.findMany({
          where: {
            tenantId,
            memberId: document.memberId,
            type: { in: requiredTypes },
            status: DocumentStatus.APPROVED,
          },
          distinct: ['type'],
          select: { type: true },
        });

        if (approvedCount.length === requiredTypes.length) {
          memberUpdate.kycStatus = KycStatus.APPROVED;
          memberUpdate.kycRejectionReason = null;

          // Auto-provision FOSA + BOSA accounts on full KYC approval
          const existing = await tx.account.findMany({
            where: {
              tenantId,
              memberId: document.memberId,
              accountType: { in: [AccountType.FOSA, AccountType.BOSA] },
            },
            select: { accountType: true },
          });
          const existingTypes = new Set(existing.map((a) => a.accountType));
          const missing = [AccountType.FOSA, AccountType.BOSA].filter(
            (t) => !existingTypes.has(t),
          );

          if (missing.length > 0) {
            const counter = await tx.tenantCounter.upsert({
              where: { tenantId },
              update: { accountSeq: { increment: missing.length } },
              create: { tenantId, memberSeq: 0, accountSeq: missing.length, loanSeq: 0 },
              select: { accountSeq: true },
            });
            const firstSeq = counter.accountSeq - missing.length + 1;
            for (const [i, accountType] of missing.entries()) {
              await tx.account.create({
                data: {
                  tenantId,
                  memberId: document.memberId,
                  accountNumber: `ACC-${accountType}-${String(firstSeq + i).padStart(6, '0')}`,
                  accountType,
                },
              });
            }
          }
        }
      }

      await tx.member.update({
        where: { id: document.memberId },
        data: memberUpdate,
      });
    });

    // Fire-and-forget email notification
    const userEmail = document.member?.user?.email;
    const firstName = document.member?.user?.firstName ?? 'Member';
    const memberNumber = document.member?.memberNumber ?? '';

    if (userEmail) {
      const emailPayload: EmailJobPayload =
        action === 'APPROVED'
          ? { type: 'MEMBER_APPROVED', to: userEmail, firstName, saccoName: 'Beba SACCO', memberNumber }
          : {
              type: 'MEMBER_REJECTED',
              to: userEmail,
              firstName,
              reason: rejectionReason ?? 'Documents did not meet requirements',
            };

      this.emailQueue
        .add('send', emailPayload, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } })
        .catch((err: unknown) =>
          this.logger.error(`Email enqueue failed for KYC job ${job.id}`, err),
        );
    }

    // Fire-and-forget audit
    this.audit
      .create({
        tenantId,
        userId: reviewerId,
        action: `KYC.DOCUMENT.${action}`,
        resource: 'Document',
        resourceId: docId,
        metadata: {
          memberId: document.memberId,
          documentType: document.type,
          action,
          rejectionReason,
        },
      })
      .catch((err: unknown) => this.logger.error('Audit write failed', err));

    this.logger.log(`KYC review job ${job.id} completed: doc=${docId} → ${action}`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<KycReviewJobPayload>, error: Error): Promise<void> {
    const maxAttempts = job.opts?.attempts ?? 5;
    if (job.attemptsMade >= maxAttempts) {
      this.logger.error(
        `KYC review job ${job.id} exhausted retries (${maxAttempts}) — routing to DLQ`,
        error.message,
      );
      await this.dlqQueue
        .add(
          'dlq',
          {
            ...job.data,
            _failedJobId: job.id,
            _error: error.message,
            _failedAt: new Date().toISOString(),
          } as unknown as KycReviewJobPayload,
          { removeOnComplete: false },
        )
        .catch((err: unknown) =>
          this.logger.error('Failed to enqueue to KYC DLQ', err),
        );
    }
  }
}
