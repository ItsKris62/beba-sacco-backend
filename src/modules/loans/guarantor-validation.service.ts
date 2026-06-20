import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { AccountType, Prisma } from '@prisma/client';
import { Decimal } from 'decimal.js';

export interface GuarantorCoverageInput {
  memberId: string;
  guaranteedAmount: Decimal | number | string;
}

export interface ProductForGuarantorValidation {
  requiredAccountType: AccountType | null;
  guarantorCoverageRatio?: Decimal | Prisma.Decimal | { toString(): string } | null;
}

export interface GuarantorCoverageResult {
  totalGuaranteed: Decimal;
  requiredCoverage: Decimal;
  coverageRatio: Decimal;
}

interface GuarantorAccountBalance {
  id: string;
  balance: Decimal;
  lockedBalance: Decimal;
  availableBalance: Decimal;
}

@Injectable()
export class GuarantorValidationService {
  async validateGuarantorCoverage(
    tx: Prisma.TransactionClient,
    tenantId: string,
    loanAmount: Decimal,
    guarantors: GuarantorCoverageInput[],
    product: ProductForGuarantorValidation,
  ): Promise<GuarantorCoverageResult> {
    const normalized = this.normalizeGuarantors(guarantors);
    const accountType = this.resolveAccountType(product);
    const coverageRatio = new Decimal(product.guarantorCoverageRatio?.toString() ?? '1.0');
    const requiredCoverage = loanAmount.times(coverageRatio).toDecimalPlaces(4);
    const totalGuaranteed = normalized.reduce(
      (sum, guarantor) => sum.plus(guarantor.guaranteedAmount),
      new Decimal(0),
    );

    if (totalGuaranteed.lessThan(requiredCoverage)) {
      throw new BadRequestException(
        `INSUFFICIENT_COVERAGE: guaranteed KES ${totalGuaranteed.toFixed(2)} is below required KES ${requiredCoverage.toFixed(2)}`,
      );
    }

    for (const guarantor of normalized) {
      const account = await this.getActiveAccount(tx, tenantId, guarantor.memberId, accountType);
      if (!account) {
        throw new BadRequestException(
          `GUARANTOR_ACCOUNT_NOT_FOUND: guarantor ${guarantor.memberId} has no active ${accountType} account`,
        );
      }

      if (guarantor.guaranteedAmount.greaterThan(account.availableBalance)) {
        throw new BadRequestException(
          `GUARANTOR_INSUFFICIENT_FUNDS: guarantor ${guarantor.memberId} available KES ${account.availableBalance.toFixed(2)} is below guaranteed KES ${guarantor.guaranteedAmount.toFixed(2)}`,
        );
      }
    }

    return { totalGuaranteed, requiredCoverage, coverageRatio };
  }

  async placeGuarantorHolds(
    tx: Prisma.TransactionClient,
    tenantId: string,
    guarantors: GuarantorCoverageInput[],
    accountType: AccountType,
  ): Promise<void> {
    const normalized = this.normalizeGuarantors(guarantors);

    for (const guarantor of normalized) {
      const account = await this.getActiveAccount(tx, tenantId, guarantor.memberId, accountType);
      if (!account) {
        throw new BadRequestException(
          `GUARANTOR_ACCOUNT_NOT_FOUND: guarantor ${guarantor.memberId} has no active ${accountType} account`,
        );
      }

      if (guarantor.guaranteedAmount.greaterThan(account.availableBalance)) {
        throw new BadRequestException(
          `GUARANTOR_INSUFFICIENT_FUNDS: guarantor ${guarantor.memberId} available KES ${account.availableBalance.toFixed(2)} is below guaranteed KES ${guarantor.guaranteedAmount.toFixed(2)}`,
        );
      }

      const guaranteedAmount = guarantor.guaranteedAmount.toDecimalPlaces(4);
      const newLockedBalance = account.lockedBalance.plus(guaranteedAmount).toDecimalPlaces(4);
      const updated = await tx.account.updateMany({
        where: {
          id: account.id,
          tenantId,
          isActive: true,
          lockedBalance: account.lockedBalance.toDecimalPlaces(4).toString(),
          balance: { gte: newLockedBalance.toString() },
        },
        data: {
          lockedBalance: { increment: guaranteedAmount.toString() },
          version: { increment: 1 },
        },
      });

      if (updated.count !== 1) {
        throw new ConflictException('Guarantor collateral changed or insufficient; please retry');
      }
    }
  }

  async releaseGuarantorHolds(
    tx: Prisma.TransactionClient,
    tenantId: string,
    guarantors: GuarantorCoverageInput[],
    accountType: AccountType,
  ): Promise<void> {
    const normalized = this.normalizeGuarantors(guarantors);

    for (const guarantor of normalized) {
      const account = await this.getActiveAccount(tx, tenantId, guarantor.memberId, accountType);
      if (!account) {
        continue;
      }

      const releaseAmount = Decimal.min(account.lockedBalance, guarantor.guaranteedAmount).toDecimalPlaces(4);
      if (releaseAmount.isZero()) {
        continue;
      }

      const updated = await tx.account.updateMany({
        where: { id: account.id, tenantId, isActive: true },
        data: {
          lockedBalance: { decrement: releaseAmount.toString() },
          version: { increment: 1 },
        },
      });

      if (updated.count !== 1) {
        throw new BadRequestException(`HOLD_RELEASE_FAILED: guarantor ${guarantor.memberId} account was not updated`);
      }
    }
  }

  resolveAccountType(product: ProductForGuarantorValidation): AccountType {
    return product.requiredAccountType ?? AccountType.FOSA;
  }

  private normalizeGuarantors(guarantors: GuarantorCoverageInput[]): Array<{
    memberId: string;
    guaranteedAmount: Decimal;
  }> {
    const seen = new Set<string>();

    return guarantors.map((guarantor) => {
      if (seen.has(guarantor.memberId)) {
        throw new BadRequestException(`DUPLICATE_GUARANTOR: guarantor ${guarantor.memberId} was nominated more than once`);
      }
      seen.add(guarantor.memberId);

      const guaranteedAmount = new Decimal(guarantor.guaranteedAmount);
      if (!guaranteedAmount.isFinite() || guaranteedAmount.lessThanOrEqualTo(0)) {
        throw new BadRequestException(`INVALID_GUARANTEE_AMOUNT: guarantor ${guarantor.memberId} amount must be greater than zero`);
      }

      return { memberId: guarantor.memberId, guaranteedAmount };
    });
  }

  private async getActiveAccount(
    tx: Prisma.TransactionClient,
    tenantId: string,
    memberId: string,
    accountType: AccountType,
  ): Promise<GuarantorAccountBalance | null> {
    const account = await tx.account.findFirst({
      where: { tenantId, memberId, accountType, isActive: true },
      select: { id: true, balance: true, lockedBalance: true },
    });

    if (!account) {
      return null;
    }

    const balance = new Decimal(account.balance.toString());
    const lockedBalance = new Decimal(account.lockedBalance?.toString() ?? '0');

    return {
      id: account.id,
      balance,
      lockedBalance,
      availableBalance: balance.minus(lockedBalance),
    };
  }
}
