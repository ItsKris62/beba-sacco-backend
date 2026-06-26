import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AccountType, GuarantorStatus, LoanStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toDecimal } from '../../common/utils/decimal.util';
import { InAppNotificationService } from '../../modules/notifications/in-app-notification.service';
import { AuditService } from '../../modules/audit/audit.service';
import { GuarantorResponse } from './dto/respond-guarantor.dto';

@Injectable()
export class GuarantorService {
  private readonly logger = new Logger(GuarantorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: InAppNotificationService,
    private readonly auditLog: AuditService,
  ) {}

  async requestGuarantor(loanId: string, requesterId: string, targetMemberId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({
        where: { id: loanId },
        include: {
          member: { include: { user: true } },
          loanProduct: true,
        },
      });
      if (!loan) throw new NotFoundException('Loan not found');

      const target = await tx.member.findFirst({
        where: { id: targetMemberId, tenantId: loan.tenantId, isActive: true },
        include: { user: true },
      });
      if (!target) throw new NotFoundException('Target member not found');
      if (target.userId === requesterId || target.id === loan.memberId) {
        throw new BadRequestException('Target member cannot be the requester');
      }
      if (target.kycStatus !== 'APPROVED' || target.isBlacklisted) {
        throw new BadRequestException('Target member must have approved KYC and be in good standing');
      }

      const currentGuarantors = await tx.loanGuarantor.count({
        where: {
          loanId,
          tenantId: loan.tenantId,
          status: { in: [GuarantorStatus.PENDING, GuarantorStatus.ACCEPTED] },
        },
      });
      if (currentGuarantors >= loan.loanProduct.maxGuarantors) {
        throw new BadRequestException('Loan already has the maximum allowed guarantors');
      }

      const guarantor = await tx.loanGuarantor.create({
        data: {
          tenantId: loan.tenantId,
          loanId,
          memberId: targetMemberId,
          status: GuarantorStatus.PENDING,
          guaranteedAmount: toDecimal(0)!,
          expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        },
      });

      await this.auditLog.createAtomic(tx, {
        tenantId: loan.tenantId,
        actorId: requesterId,
        action: 'GUARANTOR.REQUESTED',
        entityType: 'LoanGuarantor',
        entityId: guarantor.id,
        newValue: { loanId, targetMemberId, status: GuarantorStatus.PENDING },
      });

      return {
        guarantor,
        tenantId: loan.tenantId,
        targetUserId: target.userId,
        requesterName: `${loan.member.user.firstName} ${loan.member.user.lastName}`,
      };
    });

    await this.notifications
      .createAndEmit(
        result.tenantId,
        result.targetUserId,
        'Guarantor request',
        `${result.requesterName} requested you to guarantee a loan.`,
        'LOAN_GUARANTOR_REQUEST',
      )
      .catch((error: unknown) => this.logger.warn(this.errorMessage(error)));

    return result.guarantor;
  }

  async respondToRequest(
    guarantorId: string,
    response: GuarantorResponse | 'ACCEPT' | 'REJECT',
    responderId?: string,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const guarantor = await tx.loanGuarantor.findFirst({
        where: { id: guarantorId },
        include: {
          member: { include: { user: true } },
          loan: {
            include: {
              member: { include: { user: true } },
              loanProduct: true,
            },
          },
        },
      });
      if (!guarantor) throw new NotFoundException('Guarantor request not found');
      if (responderId && guarantor.member.userId !== responderId) {
        throw new BadRequestException('Only the requested guarantor can respond');
      }
      if (guarantor.status !== GuarantorStatus.PENDING) {
        throw new ConflictException('Guarantor request has already been answered');
      }

      if (response === GuarantorResponse.REJECT) {
        const rejected = await tx.loanGuarantor.update({
          where: { id: guarantor.id },
          data: {
            status: GuarantorStatus.REJECTED,
            respondedAt: new Date(),
            decidedByUserId: responderId,
            decisionSource: 'IN_APP',
          },
        });

        await this.auditLog.createAtomic(tx, {
          tenantId: guarantor.tenantId,
          actorId: responderId,
          action: 'GUARANTOR.REJECTED',
          entityType: 'LoanGuarantor',
          entityId: guarantor.id,
          oldValue: { status: GuarantorStatus.PENDING },
          newValue: { status: GuarantorStatus.REJECTED },
        });

        return {
          guarantor: rejected,
          notifyUserId: guarantor.loan.member.userId,
          tenantId: guarantor.tenantId,
          notificationTitle: 'Guarantor declined',
          notificationBody: `${guarantor.member.user.firstName} ${guarantor.member.user.lastName} declined your guarantor request.`,
        };
      }

      const requiredShare = this.provisionalShare(
        guarantor.loan.principalAmount,
        guarantor.loan.loanProduct.minGuarantors,
      );
      const bosaAccount = await tx.account.findFirst({
        where: {
          tenantId: guarantor.tenantId,
          memberId: guarantor.memberId,
          accountType: AccountType.BOSA,
          isActive: true,
        },
        select: { id: true, balance: true, lockedBalance: true, frozenSavings: true, version: true },
      });
      if (!bosaAccount) throw new NotFoundException('Guarantor BOSA account not found');

      const availableFunds = toDecimal(bosaAccount.balance)!.minus(bosaAccount.lockedBalance).minus(bosaAccount.frozenSavings);
      if (availableFunds.lessThan(requiredShare)) {
        throw new HttpException(
          'Insufficient BOSA savings to guarantee this amount',
          HttpStatus.BAD_REQUEST,
        );
      }

      const frozen = await tx.account.updateMany({
        where: {
          id: bosaAccount.id,
          version: bosaAccount.version,
          accountType: AccountType.BOSA,
        },
        data: { frozenSavings: { increment: requiredShare }, version: { increment: 1 } },
      });
      if (frozen.count === 0) {
        throw new ConflictException('Concurrent BOSA savings modification');
      }

      const accepted = await tx.loanGuarantor.update({
        where: { id: guarantor.id },
        data: {
          status: GuarantorStatus.ACCEPTED,
          guaranteedAmount: requiredShare,
          holdPlacedAt: new Date(),
          respondedAt: new Date(),
          decidedByUserId: responderId,
          decisionSource: 'IN_APP',
        },
      });

      await this.auditLog.createAtomic(tx, {
        tenantId: guarantor.tenantId,
        actorId: responderId,
        action: 'GUARANTOR.ACCEPTED',
        entityType: 'LoanGuarantor',
        entityId: guarantor.id,
        oldValue: { status: GuarantorStatus.PENDING },
        newValue: { status: GuarantorStatus.ACCEPTED, guaranteedAmount: requiredShare.toString() },
      });

      const acceptedGuarantors = await tx.loanGuarantor.findMany({
        where: {
          tenantId: guarantor.tenantId,
          loanId: guarantor.loanId,
          status: GuarantorStatus.ACCEPTED,
        },
        orderBy: { respondedAt: 'asc' },
      });

      if (acceptedGuarantors.length === guarantor.loan.loanProduct.minGuarantors) {
        await this.rebalanceAcceptedGuarantors(tx, {
          tenantId: guarantor.tenantId,
          loanId: guarantor.loanId,
          principalAmount: guarantor.loan.principalAmount,
          minGuarantors: guarantor.loan.loanProduct.minGuarantors,
          actorId: responderId,
        });

        await tx.loan.updateMany({
          where: { id: guarantor.loanId, status: LoanStatus.PENDING_GUARANTORS },
          data: { status: LoanStatus.PENDING_APPROVAL },
        });
      }

      return {
        guarantor: accepted,
        notifyUserId: guarantor.loan.member.userId,
        tenantId: guarantor.tenantId,
        notificationTitle: 'Guarantor accepted',
        notificationBody: `${guarantor.member.user.firstName} ${guarantor.member.user.lastName} accepted your guarantor request.`,
      };
    });

    await this.notifications
      .createAndEmit(
        result.tenantId,
        result.notifyUserId,
        result.notificationTitle,
        result.notificationBody,
        'LOAN_GUARANTOR_RESPONSE',
      )
      .catch((error: unknown) => this.logger.warn(this.errorMessage(error)));

    return result.guarantor;
  }

  private async rebalanceAcceptedGuarantors(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      loanId: string;
      principalAmount: Prisma.Decimal;
      minGuarantors: number;
      actorId?: string;
    },
  ) {
    const accepted = await tx.loanGuarantor.findMany({
      where: { tenantId: input.tenantId, loanId: input.loanId, status: GuarantorStatus.ACCEPTED },
      orderBy: { respondedAt: 'asc' },
      take: input.minGuarantors,
    });
    const exactShares = this.exactSplits(input.principalAmount, input.minGuarantors);

    for (let index = 0; index < accepted.length; index += 1) {
      const guarantor = accepted[index];
      const targetShare = exactShares[index];
      const currentShare = toDecimal(guarantor.guaranteedAmount)!;
      const delta = targetShare.minus(currentShare).toDecimalPlaces(4);

      if (!delta.equals(0)) {
        const account = await tx.account.findFirst({
          where: {
            tenantId: input.tenantId,
            memberId: guarantor.memberId,
            accountType: AccountType.BOSA,
            isActive: true,
          },
          select: { id: true, balance: true, lockedBalance: true, frozenSavings: true, version: true },
        });
        if (!account) throw new NotFoundException('Guarantor BOSA account not found');

        if (delta.greaterThan(0)) {
          const availableFunds = toDecimal(account.balance)!.minus(account.lockedBalance).minus(account.frozenSavings);
          if (availableFunds.lessThan(delta)) {
            throw new HttpException(
              'Insufficient BOSA savings to guarantee this amount',
              HttpStatus.BAD_REQUEST,
            );
          }
        }

        const adjusted = await tx.account.updateMany({
          where: { id: account.id, version: account.version, accountType: AccountType.BOSA },
          data: {
            frozenSavings: delta.greaterThan(0) ? { increment: delta } : { decrement: delta.abs() },
            version: { increment: 1 },
          },
        });
        if (adjusted.count === 0) {
          throw new ConflictException('Concurrent BOSA savings modification');
        }
      }

      await tx.loanGuarantor.update({
        where: { id: guarantor.id },
        data: { guaranteedAmount: targetShare, holdPlacedAt: guarantor.holdPlacedAt ?? new Date() },
      });

      await this.auditLog.createAtomic(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: 'GUARANTOR.FROZEN_SAVINGS_REBALANCED',
        entityType: 'LoanGuarantor',
        entityId: guarantor.id,
        oldValue: { guaranteedAmount: currentShare.toString() },
        newValue: { guaranteedAmount: targetShare.toString(), delta: delta.toString() },
      });
    }
  }

  private provisionalShare(amount: Prisma.Decimal, parts: number): Prisma.Decimal {
    return amount.div(parts).toDecimalPlaces(2, Prisma.Decimal.ROUND_UP).toDecimalPlaces(4);
  }

  private exactSplits(amount: Prisma.Decimal, parts: number): Prisma.Decimal[] {
    const cents = amount.times(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
    const baseCents = cents.div(parts).floor();
    const remainder = cents.minus(baseCents.times(parts)).toNumber();

    return Array.from({ length: parts }, (_, index) => {
      const addRemainderCent = index >= parts - remainder;
      return baseCents.plus(addRemainderCent ? 1 : 0).div(100).toDecimalPlaces(4);
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}



