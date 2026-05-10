import { BadRequestException, Injectable } from '@nestjs/common';
import { AccountType } from '@prisma/client';
import { Decimal } from 'decimal.js';

export interface ProductRuleProduct {
  name: string;
  requiredAccountType: AccountType | null;
  savingsMultiplier: { toString(): string } | null;
  minGuarantors: number;
  maxGuarantors: number;
}

export interface ProductRuleResult {
  eligibleSavings: Decimal;
  savingsMultiplier: Decimal;
  requiredAccountLabel: string;
  minGuarantors: number;
  maxGuarantors: number;
}

@Injectable()
export class ProductRuleService {
  resolve(product: ProductRuleProduct, fosaBalance: Decimal, bosaBalance: Decimal): ProductRuleResult {
    const requiredAccountType = product.requiredAccountType;
    const eligibleSavings =
      requiredAccountType === AccountType.BOSA
        ? bosaBalance
        : requiredAccountType === AccountType.FOSA
          ? fosaBalance
          : fosaBalance.plus(bosaBalance);

    return {
      eligibleSavings,
      savingsMultiplier: new Decimal(product.savingsMultiplier?.toString() ?? '3'),
      requiredAccountLabel: requiredAccountType ?? 'combined FOSA+BOSA',
      minGuarantors: product.minGuarantors,
      maxGuarantors: product.maxGuarantors,
    };
  }

  assertLoanApplicationRules(args: {
    product: ProductRuleProduct;
    principal: Decimal;
    guarantorCount: number;
    fosaBalance: Decimal;
    bosaBalance: Decimal;
  }): ProductRuleResult {
    const rules = this.resolve(args.product, args.fosaBalance, args.bosaBalance);

    if (rules.eligibleSavings.equals(0)) {
      throw new BadRequestException(
        `This product requires ${rules.requiredAccountLabel} savings, but none are available.`,
      );
    }

    if (args.guarantorCount < rules.minGuarantors) {
      throw new BadRequestException(
        `${args.product.name} requires minGuarantors=${rules.minGuarantors}; received ${args.guarantorCount}.`,
      );
    }

    if (rules.maxGuarantors > 0 && args.guarantorCount > rules.maxGuarantors) {
      throw new BadRequestException(
        `${args.product.name} allows at most ${rules.maxGuarantors} guarantor(s); received ${args.guarantorCount}.`,
      );
    }

    const maxLoanLimit = rules.eligibleSavings.times(rules.savingsMultiplier);
    if (args.principal.greaterThan(maxLoanLimit)) {
      throw new BadRequestException(
        `Loan amount exceeds your maximum eligible limit of KES ${maxLoanLimit.toFixed(2)} ` +
          `(${rules.savingsMultiplier.toFixed(2)}x ${rules.requiredAccountLabel} savings of KES ${rules.eligibleSavings.toFixed(2)})`,
      );
    }

    return rules;
  }
}
