import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AccountType, GuarantorStatus, LoanStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../modules/audit/audit.service';
import { InAppNotificationService } from '../modules/notifications/in-app-notification.service';
import { toDecimal } from '../common/utils/decimal.util';
import { GuarantorResponseAction } from './dto/guarantor.dto';

@Injectable()
export class GuarantorService {
  private readonly logger = new Logger(GuarantorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: InAppNotificationService,
  ) {}

  async requestGuarantor(
    tenantId: string,
    actorUserId: string,
    loanId: string,
    guarantorMemberId: string,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: { id: loanId, tenantId },
        include: { loanProduct: true, member: { include: { user: true } } },
      });
      if (!loan) throw new NotFoundException('Loan not found');
      if (loan.memberId === guarantorMemberId) {
        throw new BadRequestException('Member cannot guarantee their own loan');
      }

      const guarantor = await tx.member.findFirst({
        where: { id: guarantorMemberId, tenantId, isActive: true },
        include: { user: true },
      });
      if (!guarantor) throw new NotFoundException('Guarantor member not found');
      if (guarantor.kycStatus !== 'APPROVED' || guarantor.isBlacklisted) {
        throw new BadRequestException('Target member must have approved KYC and be in good standing');
      }

      const defaultedLoan = await tx.loan.findFirst({
        where: { tenantId, memberId: guarantorMemberId, status: LoanStatus.DEFAULTED },
        select: { id: true },
      });
      if (defaultedLoan) {
        throw new BadRequestException('Target member is not in good standing');
      }

      const guarantorRecord = await tx.loanGuarantor.create({
        data: {
          tenantId,
          loanId,
          memberId: guarantorMemberId,
          status: GuarantorStatus.PENDING,
          guaranteedAmount: '0',
          expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        },
      });

      await this.audit.createAtomic(tx, {
        tenantId,
        actorId: actorUserId,
        action: 'GUARANTOR.REQUESTED',
        entityType: 'LoanGuarantor',
        entityId: guarantorRecord.id,
        newValue: { status: GuarantorStatus.PENDING, loanId, guarantorMemberId },
      });

      return { guarantorRecord, guarantorUserId: guarantor.userId, borrowerName: `${loan.member.user.firstName} ${loan.member.user.lastName}` };
    });

    await this.notifications
      .createAndEmit(
        tenantId,
        result.guarantorUserId,
        'Guarantor request',
        `${result.borrowerName} requested you to guarantee a loan.`,
        'LOAN_GUARANTOR_REQUEST',
      )
      .catch((error: unknown) =>
        this.logger.warn(`Notification failed: ${error instanceof Error ? error.message : String(error)}`),
      );

    return result.guarantorRecord;
  }

  async respondToRequest(
    tenantId: string,
    actorUserId: string,
    guarantorId: string,
    action: GuarantorResponseAction,
    notes?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const guarantor = await tx.loanGuarantor.findFirst({
        where: { id: guarantorId, tenantId },
        include: {
          loan: { include: { loanProduct: true } },
          member: { select: { id: true, userId: true } },
        },
      });
      if (!guarantor) throw new NotFoundException('Guarantor request not found');
      if (guarantor.status !== GuarantorStatus.PENDING) {
        throw new ConflictException('Guarantor request has already been answered');
      }
      if (guarantor.member.userId !== actorUserId) {
        throw new BadRequestException('Only the requested guarantor can respond');
      }

      if (action === GuarantorResponseAction.REJECT) {
        const rejected = await tx.loanGuarantor.update({
          where: { id: guarantor.id },
          data: {
            status: GuarantorStatus.REJECTED,
            notes,
            respondedAt: new Date(),
            decidedByUserId: actorUserId,
            decisionSource: 'IN_APP',
          },
        });
        await this.audit.createAtomic(tx, {
          tenantId,
          actorId: actorUserId,
          action: 'GUARANTOR.REJECTED',
          entityType: 'LoanGuarantor',
          entityId: guarantor.id,
          oldValue: { status: GuarantorStatus.PENDING },
          newValue: { status: GuarantorStatus.REJECTED, notes },
        });
        return rejected;
      }

      const principal = toDecimal(guarantor.loan.principalAmount.toString())!;
      const minGuarantors = guarantor.loan.loanProduct.minGuarantors;
      const provisionalShare = this.splitAmount(principal, minGuarantors)[0];
      const available = await this.getAvailableBosa(tx, tenantId, guarantor.memberId);
      if (available.lessThan(provisionalShare)) {
        throw new BadRequestException('Guarantor has insufficient available BOSA savings');
      }

      const accepted = await tx.loanGuarantor.update({
        where: { id: guarantor.id },
        data: {
          status: GuarantorStatus.ACCEPTED,
          respondedAt: new Date(),
          decidedByUserId: actorUserId,
          decisionSource: 'IN_APP',
        },
      });

      await this.audit.createAtomic(tx, {
        tenantId,
        actorId: actorUserId,
        action: 'GUARANTOR.ACCEPTED',
        entityType: 'LoanGuarantor',
        entityId: guarantor.id,
        oldValue: { status: GuarantorStatus.PENDING },
        newValue: { status: GuarantorStatus.ACCEPTED },
      });

      const acceptedGuarantors = await tx.loanGuarantor.findMany({
        where: { tenantId, loanId: guarantor.loanId, status: GuarantorStatus.ACCEPTED },
        orderBy: { respondedAt: 'asc' },
      });

      if (acceptedGuarantors.length >= minGuarantors) {
        await this.freezeAcceptedGuarantors(tx, tenantId, guarantor.loanId, principal, minGuarantors, actorUserId);
      }

      return accepted;
    });
  }

  private async freezeAcceptedGuarantors(
    tx: Prisma.TransactionClient,
    tenantId: string,
    loanId: string,
    principal: Prisma.Decimal,
    minGuarantors: number,
    actorUserId: string,
  ) {
    const guarantors = await tx.loanGuarantor.findMany({
      where: { tenantId, loanId, status: GuarantorStatus.ACCEPTED },
      orderBy: { respondedAt: 'asc' },
      take: minGuarantors,
    });
    if (guarantors.length < minGuarantors) return;

    const splits = this.splitAmount(principal, minGuarantors);

    for (let index = 0; index < guarantors.length; index += 1) {
      const guarantor = guarantors[index];
      const share = splits[index];
      const account = await tx.account.findFirst({
        where: { tenantId, memberId: guarantor.memberId, accountType: AccountType.BOSA, isActive: true },
        select: { id: true, balance: true, lockedBalance: true, frozenSavings: true, version: true },
      });
      if (!account) throw new NotFoundException('Guarantor BOSA account not found');

      const pendingLiabilities = await this.getPendingLoanLiabilities(tx, tenantId, guarantor.memberId, loanId);
      const available = toDecimal(account.balance.toString())!
        .minus(account.lockedBalance).minus(account.frozenSavings)
        .minus(pendingLiabilities);
      if (available.lessThan(share)) {
        throw new BadRequestException('Guarantor has insufficient available BOSA savings');
      }

      const updated = await tx.account.updateMany({
        where: { id: account.id, tenantId, version: account.version },
        data: { frozenSavings: { increment: share }, version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new ConflictException('Concurrent guarantor balance modification');
      }

      await tx.loanGuarantor.update({
        where: { id: guarantor.id },
        data: { guaranteedAmount: share, holdPlacedAt: new Date() },
      });

      await this.audit.createAtomic(tx, {
        tenantId,
        actorId: actorUserId,
        action: 'GUARANTOR.FUNDS_FROZEN',
        entityType: 'LoanGuarantor',
        entityId: guarantor.id,
        newValue: { guaranteedAmount: share.toString(), accountId: account.id },
      });
    }

    await tx.loan.updateMany({
      where: { id: loanId, tenantId, status: LoanStatus.PENDING_GUARANTORS },
      data: { status: LoanStatus.PENDING_APPROVAL },
    });
  }

  private async getAvailableBosa(
    tx: Prisma.TransactionClient,
    tenantId: string,
    memberId: string,
  ): Promise<Prisma.Decimal> {
    const account = await tx.account.findFirst({
      where: { tenantId, memberId, accountType: AccountType.BOSA, isActive: true },
      select: { balance: true, lockedBalance: true, frozenSavings: true },
    });
    if (!account) throw new NotFoundException('Guarantor BOSA account not found');
    const pendingLiabilities = await this.getPendingLoanLiabilities(tx, tenantId, memberId);
    return toDecimal(account.balance.toString())!.minus(account.lockedBalance).minus(account.frozenSavings).minus(pendingLiabilities);
  }

  private async getPendingLoanLiabilities(
    tx: Prisma.TransactionClient,
    tenantId: string,
    memberId: string,
    excludeLoanId?: string,
  ): Promise<Prisma.Decimal> {
    const guarantees = await tx.loanGuarantor.findMany({
      where: {
        tenantId,
        memberId,
        status: GuarantorStatus.ACCEPTED,
        holdPlacedAt: null,
        loanId: excludeLoanId ? { not: excludeLoanId } : undefined,
      },
      select: { guaranteedAmount: true },
    });
    return guarantees.reduce(
      (sum, guarantee) => sum.plus(guarantee.guaranteedAmount),
      toDecimal(0)!,
    );
  }

  private splitAmount(amount: Prisma.Decimal, parts: number): Prisma.Decimal[] {
    const cents = amount.times(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
    const base = cents.div(parts).floor();
    const remainder = cents.minus(base.times(parts)).toNumber();
    return Array.from({ length: parts }, (_, index) =>
      base.plus(index < remainder ? 1 : 0).div(100).toDecimalPlaces(4),
    );
  }
}

