import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountType, KycStatus } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../prisma/prisma.service';

export interface GuarantorLookupResult {
  memberId: string;
  name: string;
  kycStatus: 'KYC_VERIFIED';
  availableBalance: number;
  tenantId: string;
}

@Injectable()
export class GuarantorLookupService {
  constructor(private readonly prisma: PrismaService) {}

  async lookupByNationalId(
    idNumber: string,
    tenantId: string,
    requesterMemberId: string,
  ): Promise<GuarantorLookupResult> {
    if (typeof idNumber !== 'string') {
      throw new BadRequestException('INVALID_ID_NUMBER: idNumber is required');
    }
    const normalizedId = idNumber.trim();
    if (!/^[0-9]{7,8}$/.test(normalizedId)) {
      throw new BadRequestException('INVALID_ID_NUMBER: Kenyan National ID must be 7–8 digits');
    }

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
          where: { tenantId, isActive: true, accountType: AccountType.FOSA },
          select: { balance: true, lockedBalance: true },
        },
      },
    });

    if (!member) {
      throw new NotFoundException('GUARANTOR_NOT_FOUND: no active SACCO member found for that National ID');
    }
    if (member.id === requesterMemberId) {
      throw new BadRequestException('SELF_GUARANTEE_NOT_ALLOWED: member cannot guarantee their own loan');
    }
    if (member.kycStatus !== KycStatus.APPROVED) {
      throw new BadRequestException('GUARANTOR_KYC_NOT_VERIFIED: guarantor KYC must be verified');
    }

    const availableBalance = member.accounts.reduce((sum, account) => {
      const balance = new Decimal(account.balance.toString());
      const locked = new Decimal(account.lockedBalance?.toString() ?? '0');
      return sum.plus(balance.minus(locked));
    }, new Decimal(0));

    return {
      memberId: member.id,
      name: [member.user.firstName, member.user.lastName].filter(Boolean).join(' '),
      kycStatus: 'KYC_VERIFIED',
      availableBalance: availableBalance.toDecimalPlaces(4).toNumber(),
      tenantId: member.tenantId,
    };
  }
}