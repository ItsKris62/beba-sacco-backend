import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountType, KycStatus } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../prisma/prisma.service';

export interface GuarantorLookupResult {
  memberId: string;
  maskedName: string;
  kycStatus: 'KYC_VERIFIED';
  eligible: boolean;
  reason?: string;
}

@Injectable()
export class GuarantorLookupService {
  constructor(private readonly prisma: PrismaService) {}

  async lookupByNationalId(
    idNumber: string,
    tenantId: string,
    requesterMemberId: string,
    requiredAmount?: Decimal.Value,
    loanProductId?: string,
  ): Promise<GuarantorLookupResult> {
    if (typeof idNumber !== 'string') {
      throw new BadRequestException('INVALID_ID_NUMBER: idNumber is required');
    }
    const normalizedId = idNumber.trim();
    if (!/^[0-9]{7,8}$/.test(normalizedId)) {
      throw new BadRequestException('INVALID_ID_NUMBER: Kenyan National ID must be 7–8 digits');
    }

    const product = loanProductId
      ? await this.prisma.loanProduct.findFirst({
          where: { id: loanProductId, tenantId, isActive: true },
          select: { requiredAccountType: true },
        })
      : null;
    const accountType = product?.requiredAccountType ?? AccountType.FOSA;

    const member = await this.prisma.member.findFirst({
      where: {
        tenantId,
        nationalId: normalizedId,
        isActive: true,
        deletedAt: null,
        user: { isActive: true, status: 'APPROVED' },
      },
      select: {
        id: true,
        tenantId: true,
        kycStatus: true,
        user: { select: { firstName: true, lastName: true } },
        accounts: {
          where: { tenantId, isActive: true, accountType },
          select: { balance: true, lockedBalance: true },
        },
      },
    });

    if (!member) {
      throw new NotFoundException('GUARANTOR_NOT_FOUND: no active SACCO member found for that National ID');
    }
    const availableBalance = member.accounts.reduce((sum, account) => {
      const balance = new Decimal(account.balance.toString());
      const locked = new Decimal(account.lockedBalance?.toString() ?? '0');
      return sum.plus(balance.minus(locked));
    }, new Decimal(0));
    const required = new Decimal(requiredAmount ?? 0).toDecimalPlaces(4);
    let eligible = true;
    let reason: string | undefined;

    if (member.id === requesterMemberId) {
      eligible = false;
      reason = 'SELF_GUARANTEE_NOT_ALLOWED';
    } else if (member.kycStatus !== KycStatus.APPROVED) {
      eligible = false;
      reason = 'GUARANTOR_KYC_NOT_VERIFIED';
    } else if (required.greaterThan(0) && availableBalance.lessThan(required)) {
      eligible = false;
      reason = `GUARANTOR_INSUFFICIENT_FUNDS: available ${accountType} KES ${availableBalance.toFixed(2)} is below required KES ${required.toFixed(2)}`;
    }

    return {
      memberId: member.id,
      maskedName: this.maskName(member.user.firstName, member.user.lastName),
      kycStatus: 'KYC_VERIFIED',
      eligible,
      ...(reason && { reason }),
    };
  }

  private maskName(firstName?: string | null, lastName?: string | null): string {
    const maskPart = (value?: string | null) => {
      const trimmed = (value ?? '').trim();
      if (!trimmed) return '****';
      return `${trimmed[0].toUpperCase()}${'*'.repeat(Math.max(4, trimmed.length - 1))}`;
    };
    return `${maskPart(firstName)} ${maskPart(lastName)}`;
  }
}
