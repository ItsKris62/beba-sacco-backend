import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountType, GuarantorStatus, KycStatus, LoanStatus, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { Decimal } from 'decimal.js';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { GuarantorValidationService } from '../modules/loans/guarantor-validation.service';
import { IdempotencyService } from '../common/services/idempotency.service';

export type GuarantorWorkflowAction = 'ACCEPT' | 'DECLINE';

export interface GuarantorWorkflowDto {
  action: GuarantorWorkflowAction;
  notes?: string;
}

interface LockedGuarantorRow {
  id: string;
  status: GuarantorStatus;
  invitedAt: Date;
  guaranteedAmount: string;
  memberId: string;
}

@Injectable()
export class GuarantorResponseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly guarantorValidation: GuarantorValidationService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async getPendingRequests(tenantId: string, guarantorMemberId: string) {
    const requests = await this.prisma.loanGuarantor.findMany({
      where: { tenantId, memberId: guarantorMemberId, status: GuarantorStatus.PENDING },
      orderBy: { invitedAt: 'desc' },
      select: {
        status: true,
        guaranteedAmount: true,
        loan: {
          select: {
            id: true,
            loanNumber: true,
            principalAmount: true,
            purpose: true,
            member: { select: { user: { select: { firstName: true, lastName: true } } } },
          },
        },
      },
    });

    return requests.map((request) => ({
      loanId: request.loan.id,
      loanNumber: request.loan.loanNumber,
      applicantName: [request.loan.member.user.firstName, request.loan.member.user.lastName].filter(Boolean).join(' '),
      amount: new Decimal(request.loan.principalAmount.toString()).toNumber(),
      guaranteedAmount: new Decimal(request.guaranteedAmount.toString()).toNumber(),
      status: request.status,
      purpose: request.loan.purpose,
    }));
  }

  async respondAsMember(
    loanId: string,
    guarantorMemberId: string,
    dto: GuarantorWorkflowDto,
    tenantId: string,
    actorUserId: string,
    req: Request,
    idempotencyHeader?: string,
  ) {
    if (!idempotencyHeader?.trim()) {
      throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    }
    const member = await this.prisma.member.findFirst({
      where: { id: guarantorMemberId, tenantId, isActive: true, userId: actorUserId },
      select: { id: true },
    });
    if (!member) throw new ForbiddenException('Not authorized to respond to this guarantor request');

    const headerKey = idempotencyHeader?.trim();
    const idemKey = headerKey ? `guarantor:response:${loanId}:${guarantorMemberId}:${headerKey}` : undefined;
    if (idemKey) {
      const idem = await this.idempotency.checkAndReserve(idemKey, tenantId, 72 * 60 * 60);
      if (idem.status === 'COMPLETED') return idem.result;
      if (idem.status === 'PROCESSING') throw new ConflictException('Guarantor response is already processing');
    }

    try {
      const result = await this.applyDecision({
        loanId,
        tenantId,
        actorUserId,
        guarantorMatcher: { memberId: guarantorMemberId },
        action: dto.action,
        notes: dto.notes,
        source: 'MEMBER',
        req,
      });
      if (idemKey) await this.idempotency.complete(idemKey, tenantId, result, 72 * 60 * 60);
      return result;
    } catch (error) {
      if (idemKey) await this.idempotency.release(idemKey, tenantId);
      throw error;
    }
  }

  async adminOverride(
    loanId: string,
    guarantorIdOrMemberId: string,
    dto: GuarantorWorkflowDto,
    tenantId: string,
    actorUserId: string,
    req: Request,
  ) {
    if (!dto.notes?.trim()) {
      throw new BadRequestException('ADMIN_OVERRIDE_REASON_REQUIRED');
    }
    return this.applyDecision({
      loanId,
      tenantId,
      actorUserId,
      guarantorMatcher: { idOrMemberId: guarantorIdOrMemberId },
      action: dto.action,
      notes: dto.notes,
      source: 'ADMIN_OVERRIDE',
      req,
    });
  }

  async expirePendingGuarantor(loanId: string, guarantorId: string, tenantId: string) {
    return this.applyDecision({
      loanId,
      tenantId,
      actorUserId: null,
      guarantorMatcher: { idOrMemberId: guarantorId },
      action: 'DECLINE',
      notes: 'Consent window expired (72h)',
      source: 'SYSTEM_EXPIRY',
    });
  }

  private async applyDecision(args: {
    loanId: string;
    tenantId: string;
    actorUserId: string | null;
    guarantorMatcher: { memberId?: string; idOrMemberId?: string };
    action: GuarantorWorkflowAction;
    notes?: string;
    source: 'MEMBER' | 'ADMIN_OVERRIDE' | 'SYSTEM_EXPIRY';
    req?: Request;
  }) {
    if (args.action !== 'ACCEPT' && args.action !== 'DECLINE') {
      throw new BadRequestException('INVALID_GUARANTOR_ACTION: action must be ACCEPT or DECLINE');
    }

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockGuarantor(tx, args.tenantId, args.loanId, args.guarantorMatcher);
      if (!locked) throw new NotFoundException('Guarantor request not found');
      if (locked.status !== GuarantorStatus.PENDING) {
        throw new ConflictException(`Guarantor request already ${locked.status}`);
      }

      const loan = await tx.loan.findFirst({
        where: { id: args.loanId, tenantId: args.tenantId },
        select: {
          id: true,
          status: true,
          principalAmount: true,
          loanProduct: { select: { minGuarantors: true, guarantorCoverageRatio: true, requiredAccountType: true } },
        },
      });
      if (!loan) throw new NotFoundException('Loan not found');

      const expired = args.source === 'SYSTEM_EXPIRY' || Date.now() > locked.invitedAt.getTime() + 72 * 60 * 60 * 1000;
      const nextStatus = expired
        ? GuarantorStatus.EXPIRED
        : args.action === 'ACCEPT'
          ? GuarantorStatus.ACCEPTED
          : GuarantorStatus.REJECTED;
      const accountType = this.resolveAccountType(loan.loanProduct);

      if (nextStatus === GuarantorStatus.ACCEPTED) {
        await this.assertGuarantorCanAccept(tx, args.tenantId, locked.memberId);
        await this.guarantorValidation.placeGuarantorHolds(
          tx,
          args.tenantId,
          [{ memberId: locked.memberId, guaranteedAmount: locked.guaranteedAmount }],
          accountType,
        );
      }

      await tx.loanGuarantor.updateMany({
        where: { id: locked.id, tenantId: args.tenantId, status: GuarantorStatus.PENDING },
        data: {
          status: nextStatus,
          respondedAt: new Date(),
          holdPlacedAt: nextStatus === GuarantorStatus.ACCEPTED ? new Date() : undefined,
          notes: nextStatus === GuarantorStatus.EXPIRED ? 'Consent window expired (72h)' : args.notes,
          decidedByUserId: args.actorUserId,
          decisionSource: args.source,
          auditMetadata: this.auditMetadata(args.req, args.source),
        },
      });

      if (nextStatus === GuarantorStatus.ACCEPTED) {
        await this.writeAudit(tx, {
          tenantId: args.tenantId,
          actorId: args.actorUserId,
          action: 'GUARANTOR.HOLD_PLACED',
          entityType: 'LoanGuarantor',
          entityId: locked.id,
          oldValue: { lockedBalance: 'UNCHANGED' },
          newValue: { lockedBalance: 'INCREMENTED' },
          payload: { loanId: args.loanId, guarantorMemberId: locked.memberId, guaranteedAmount: locked.guaranteedAmount, accountType },
        });
      }

      await this.writeAudit(tx, {
        tenantId: args.tenantId,
        actorId: args.actorUserId,
        action: args.source === 'ADMIN_OVERRIDE' ? 'GUARANTOR.ADMIN_OVERRIDE' : `GUARANTOR.${nextStatus}`,
        entityType: 'LoanGuarantor',
        entityId: locked.id,
        oldValue: { status: locked.status },
        newValue: { status: nextStatus },
        payload: { loanId: args.loanId, guarantorMemberId: locked.memberId, reason: args.notes, source: args.source },
      });

      const transition = await this.applyLoanState(tx, args.tenantId, args.loanId, loan, args.actorUserId, nextStatus);
      return { loanId: args.loanId, guarantorId: locked.id, memberId: locked.memberId, status: nextStatus, loanStatus: transition };
    });
  }

  private async lockGuarantor(
    tx: Prisma.TransactionClient,
    tenantId: string,
    loanId: string,
    matcher: { memberId?: string; idOrMemberId?: string },
  ): Promise<LockedGuarantorRow | null> {
    const rows = matcher.memberId
      ? await tx.$queryRaw<LockedGuarantorRow[]>`
          SELECT id, status, "invitedAt", "guaranteedAmount", "memberId"
          FROM "Guarantor"
          WHERE "tenantId" = ${tenantId} AND "loanId" = ${loanId} AND "memberId" = ${matcher.memberId}
          FOR UPDATE
        `
      : await tx.$queryRaw<LockedGuarantorRow[]>`
          SELECT id, status, "invitedAt", "guaranteedAmount", "memberId"
          FROM "Guarantor"
          WHERE "tenantId" = ${tenantId} AND "loanId" = ${loanId}
            AND (id = ${matcher.idOrMemberId} OR "memberId" = ${matcher.idOrMemberId})
          FOR UPDATE
        `;
    return rows[0] ?? null;
  }

  private async assertGuarantorCanAccept(tx: Prisma.TransactionClient, tenantId: string, memberId: string): Promise<void> {
    const member = await tx.member.findFirst({
      where: { id: memberId, tenantId, isActive: true, user: { isActive: true, status: 'APPROVED' } },
      select: { kycStatus: true },
    });
    if (!member) throw new BadRequestException('GUARANTOR_NOT_ACTIVE: guarantor must be an active SACCO member');
    if (member.kycStatus !== KycStatus.APPROVED) {
      throw new BadRequestException('GUARANTOR_KYC_NOT_VERIFIED: guarantor KYC must be verified');
    }
  }

  private async applyLoanState(
    tx: Prisma.TransactionClient,
    tenantId: string,
    loanId: string,
    loan: { status: LoanStatus; principalAmount: Prisma.Decimal; loanProduct: { minGuarantors: number; guarantorCoverageRatio: Prisma.Decimal; requiredAccountType: AccountType | null } },
    actorId: string | null,
    latestStatus: GuarantorStatus,
  ): Promise<LoanStatus> {
    if (loan.status !== LoanStatus.PENDING_GUARANTORS) return loan.status;

    const guarantors = await tx.loanGuarantor.findMany({
      where: { tenantId, loanId },
      select: { id: true, memberId: true, status: true, guaranteedAmount: true, holdReleasedAt: true },
    });
    const accepted = guarantors.filter((guarantor) => guarantor.status === GuarantorStatus.ACCEPTED);
    const pending = guarantors.filter((guarantor) => guarantor.status === GuarantorStatus.PENDING);
    const totalAccepted = accepted.reduce((sum, item) => sum.plus(new Decimal(item.guaranteedAmount.toString())), new Decimal(0));
    const requiredCoverage = new Decimal(loan.principalAmount.toString()).times(
      new Decimal(loan.loanProduct.guarantorCoverageRatio?.toString() ?? '1.0'),
    );

    const hasDecline = guarantors.some(
      (guarantor) => guarantor.status === GuarantorStatus.REJECTED || guarantor.status === GuarantorStatus.EXPIRED,
    );
    const criteriaMet =
      pending.length === 0 &&
      accepted.length >= loan.loanProduct.minGuarantors &&
      totalAccepted.greaterThanOrEqualTo(requiredCoverage);

    if (hasDecline || latestStatus === GuarantorStatus.EXPIRED || (pending.length === 0 && !criteriaMet)) {
      await this.releaseAcceptedHolds(tx, tenantId, loanId, loan.loanProduct, accepted, actorId, 'GUARANTOR_DECLINE_OR_TIMEOUT');
      await tx.loan.updateMany({
        where: { id: loanId, tenantId, status: LoanStatus.PENDING_GUARANTORS },
        data: { status: LoanStatus.REJECTED_GUARANTOR_DECLINE, notes: 'REJECTED_GUARANTOR_DECLINE' },
      });
      await this.writeAudit(tx, {
        tenantId,
        actorId,
        action: 'LOAN.REJECTED_GUARANTOR_DECLINE',
        entityType: 'Loan',
        entityId: loanId,
        oldValue: { status: loan.status },
        newValue: { status: LoanStatus.REJECTED_GUARANTOR_DECLINE },
        payload: { acceptedCount: accepted.length, totalAccepted: totalAccepted.toString(), requiredCoverage: requiredCoverage.toString() },
      });
      return LoanStatus.REJECTED_GUARANTOR_DECLINE;
    }

    if (criteriaMet) {
      await tx.loan.updateMany({
        where: { id: loanId, tenantId, status: LoanStatus.PENDING_GUARANTORS },
        data: { status: LoanStatus.PENDING_REVIEW },
      });
      await this.writeAudit(tx, {
        tenantId,
        actorId,
        action: 'LOAN.PENDING_REVIEW',
        entityType: 'Loan',
        entityId: loanId,
        oldValue: { status: loan.status },
        newValue: { status: LoanStatus.PENDING_REVIEW },
        payload: { acceptedCount: accepted.length, totalAccepted: totalAccepted.toString(), requiredCoverage: requiredCoverage.toString() },
      });
      return LoanStatus.PENDING_REVIEW;
    }

    return loan.status;
  }

  private async releaseAcceptedHolds(
    tx: Prisma.TransactionClient,
    tenantId: string,
    loanId: string,
    product: { requiredAccountType: AccountType | null },
    accepted: Array<{ id: string; memberId: string; guaranteedAmount: Prisma.Decimal; holdReleasedAt: Date | null }>,
    actorId: string | null,
    reason: string,
  ): Promise<void> {
    const accountType = this.resolveAccountType(product);
    for (const guarantor of accepted) {
      if (guarantor.holdReleasedAt) continue;
      await this.guarantorValidation.releaseGuarantorHolds(
        tx,
        tenantId,
        [{ memberId: guarantor.memberId, guaranteedAmount: guarantor.guaranteedAmount.toString() }],
        accountType,
      );
      await tx.loanGuarantor.updateMany({
        where: { id: guarantor.id, tenantId },
        data: { holdReleasedAt: new Date() },
      });
      await this.writeAudit(tx, {
        tenantId,
        actorId,
        action: 'GUARANTOR.HOLD_RELEASED',
        entityType: 'LoanGuarantor',
        entityId: guarantor.id,
        payload: { loanId, guarantorMemberId: guarantor.memberId, guaranteedAmount: guarantor.guaranteedAmount.toString(), accountType, reason },
      });
    }
  }

  private resolveAccountType(product: { requiredAccountType: AccountType | null }): AccountType {
    return product.requiredAccountType ?? AccountType.FOSA;
  }

  private auditMetadata(req: Request | undefined, source: string): Prisma.InputJsonValue {
    return {
      source,
      ipAddress: req?.ip ?? null,
      userAgent: req?.headers['user-agent'] ?? null,
      deviceId: req?.headers['x-device-id'] ?? null,
      jurisdiction: 'KE',
      retentionYears: 7,
      timestamp: new Date().toISOString(),
    };
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    data: {
      tenantId: string;
      actorId: string | null;
      action: string;
      entityType: string;
      entityId: string;
      oldValue?: Record<string, unknown>;
      newValue?: Record<string, unknown>;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    const timestamp = new Date();
    const prev = await tx.auditLog.findFirst({
      where: { tenantId: data.tenantId },
      orderBy: { timestamp: 'desc' },
      select: { entryHash: true },
    });
    const prevHash = prev?.entryHash ?? null;
    const entryHash = createHash('sha256')
      .update(JSON.stringify({ ...data, prevHash, timestamp: timestamp.toISOString() }), 'utf8')
      .digest('hex');

    await tx.auditLog.create({
      data: {
        tenantId: data.tenantId,
        actorId: data.actorId,
        action: data.action,
        entityType: data.entityType,
        entityId: data.entityId,
        oldValue: data.oldValue ? (data.oldValue as Prisma.InputJsonValue) : Prisma.JsonNull,
        newValue: data.newValue ? (data.newValue as Prisma.InputJsonValue) : Prisma.JsonNull,
        metadata: data.payload as Prisma.InputJsonValue,
        payload: data.payload as Prisma.InputJsonValue,
        prevHash,
        entryHash,
        timestamp,
      },
    });
  }
}