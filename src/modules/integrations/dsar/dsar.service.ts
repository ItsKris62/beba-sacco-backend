import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * DSAR (Data Subject Access Request) Automation – Phase 5
 *
 * Implements Kenya Data Protection Act (DPA) / GDPR compliance:
 *   1. POST /admin/compliance/dsar/request → Aggregates all PII for a member
 *   2. Generates encrypted ZIP with audit trail
 *   3. Auto-redacts download URL after 30 days
 *
 * Data included in DSAR export:
 *   - Member profile (PII)
 *   - Account balances
 *   - Transaction history
 *   - Loan records
 *   - Guarantor relationships
 *   - Audit log entries
 *   - Consent records
 */
@Injectable()
export class DsarService {
  private readonly logger = new Logger(DsarService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * POST /admin/compliance/dsar/request
   * Initiates a DSAR for a member. Aggregates all PII and generates download.
   */
  async createRequest(params: {
    tenantId: string;
    memberId: string;
    requestedBy: string;
  }) {
    const { tenantId, memberId, requestedBy } = params;

    // Verify member exists
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, tenantId },
      select: { id: true, memberNumber: true },
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    // Create DSAR request record
    const dsarRequest = await this.prisma.dsarRequest.create({
      data: {
        tenantId,
        memberId,
        requestedBy,
        status: 'PROCESSING',
      },
    });

    try {
      // Aggregate all member data
      const memberData = await this.aggregateMemberData(tenantId, memberId);

      // Generate data package (in production: encrypt and upload to MinIO)
      const dataPackage = JSON.stringify(memberData, null, 2);
      const dataHash = createHash('sha256').update(dataPackage).digest('hex');

      // In production: Upload encrypted ZIP to MinIO and get pre-signed URL
      // For now, store a mock download URL
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // 30-day expiry

      const mockDownloadUrl = `/api/v1/admin/compliance/dsar/${dsarRequest.id}/download`;

      await this.prisma.dsarRequest.update({
        where: { id: dsarRequest.id },
        data: {
          status: 'COMPLETED',
          downloadUrl: mockDownloadUrl,
          expiresAt,
          auditTrail: {
            dataHash,
            aggregatedAt: new Date().toISOString(),
            sections: Object.keys(memberData),
            recordCounts: {
              transactions: memberData.accounts.reduce((sum, a) => sum + a.transactions.length, 0),
              loans: memberData.loans?.length ?? 0,
              guarantorships: memberData.guarantorships?.length ?? 0,
              auditLogs: memberData.auditLogs?.length ?? 0,
            },
          } as unknown as Prisma.InputJsonValue,
        },
      });

      this.logger.log(`DSAR completed: ${dsarRequest.id} for member ${memberId}`);

      return {
        dsarRequestId: dsarRequest.id,
        status: 'COMPLETED',
        downloadUrl: mockDownloadUrl,
        expiresAt: expiresAt.toISOString(),
        dataHash,
      };
    } catch (err) {
      await this.prisma.dsarRequest.update({
        where: { id: dsarRequest.id },
        data: { status: 'PENDING' },
      });
      throw err;
    }
  }

  /**
   * Aggregate all PII and related data for a member.
   */
  private async aggregateMemberData(tenantId: string, memberId: string) {
    const [member, accounts, loans, guarantorships, auditLogs] = await Promise.all([
      // Member profile with user data
      this.prisma.member.findFirst({
        where: { id: memberId, tenantId },
        include: {
          user: {
            select: {
              email: true,
              firstName: true,
              lastName: true,
              phone: true,
              role: true,
              createdAt: true,
              lastLoginAt: true,
            },
          },
        },
      }),

      // Account balances and transactions
      this.prisma.account.findMany({
        where: { memberId, tenantId },
        include: {
          transactions: {
            orderBy: { createdAt: 'desc' },
            take: 1000, // Last 1000 transactions
            select: {
              id: true,
              type: true,
              amount: true,
              status: true,
              reference: true,
              description: true,
              createdAt: true,
            },
          },
        },
      }),

      // Loan records
      this.prisma.loan.findMany({
        where: { memberId, tenantId },
        select: {
          id: true,
          loanNumber: true,
          status: true,
          principalAmount: true,
          outstandingBalance: true,
          totalRepaid: true,
          arrearsDays: true,
          staging: true,
          appliedAt: true,
          approvedAt: true,
          disbursedAt: true,
          dueDate: true,
        },
      }),

      // Guarantor relationships (both as guarantor and borrower)
      this.prisma.guarantor.findMany({
        where: { memberId, tenantId },
        select: {
          id: true,
          loanId: true,
          status: true,
          guaranteedAmount: true,
          invitedAt: true,
          respondedAt: true,
        },
      }),

      // Audit log entries related to this member
      this.prisma.auditLog.findMany({
        where: {
          tenantId,
          OR: [
            { resourceId: memberId },
            { userId: memberId },
          ],
        },
        orderBy: { timestamp: 'desc' },
        take: 500,
        select: {
          action: true,
          resource: true,
          timestamp: true,
          ipAddress: true,
        },
      }),
    ]);

    return {
      exportDate: new Date().toISOString(),
      member: member
        ? {
            memberNumber: member.memberNumber,
            nationalId: member.nationalId,
            kraPin: member.kraPin,
            employer: member.employer,
            occupation: member.occupation,
            dateOfBirth: member.dateOfBirth?.toISOString(),
            joinedAt: member.joinedAt.toISOString(),
            consentDataSharing: member.consentDataSharing,
            consentUpdatedAt: member.consentUpdatedAt?.toISOString(),
            user: member.user,
          }
        : null,
      accounts: accounts.map((a) => ({
        accountNumber: a.accountNumber,
        accountType: a.accountType,
        balance: a.balance.toString(),
        transactions: a.transactions,
      })),
      loans,
      guarantorships,
      auditLogs,
    };
  }

  /**
   * Get DSAR request status.
   */
  async getRequest(dsarRequestId: string, tenantId: string) {
    const request = await this.prisma.dsarRequest.findFirst({
      where: { id: dsarRequestId, tenantId },
    });

    if (!request) {
      throw new NotFoundException('DSAR request not found');
    }

    return request;
  }

  /**
   * List DSAR requests for a tenant.
   */
  async listRequests(tenantId: string, memberId?: string) {
    return this.prisma.dsarRequest.findMany({
      where: {
        tenantId,
        ...(memberId && { memberId }),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /**
   * Cron: Auto-redact expired DSAR downloads (30 days after generation).
   * Runs daily at 3:00 AM EAT.
   */
  @Cron('0 3 * * *', { timeZone: 'Africa/Nairobi' })
  async redactExpiredRequests(): Promise<void> {
    const now = new Date();

    const expired = await this.prisma.dsarRequest.findMany({
      where: {
        status: 'COMPLETED',
        expiresAt: { lte: now },
        redactedAt: null,
      },
    });

    if (expired.length === 0) return;

    for (const request of expired) {
      await this.prisma.dsarRequest.update({
        where: { id: request.id },
        data: {
          status: 'REDACTED',
          downloadUrl: null,
          redactedAt: now,
        },
      });

      // In production: Delete the encrypted ZIP from MinIO
      this.logger.log(`DSAR ${request.id} redacted (expired)`);
    }

    this.logger.log(`Redacted ${expired.length} expired DSAR requests`);
  }
}
