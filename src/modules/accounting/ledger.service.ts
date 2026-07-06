import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Decimal } from 'decimal.js';
import {
  Prisma,
  AccountType,
  JournalEntryStatus,
  JournalEntryType,
  TransactionStatus,
  TransactionType,
  UserRole,
  type Transaction,
  type JournalEntry,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

type PrismaTx = Prisma.TransactionClient;
type Direction = 'DEBIT' | 'CREDIT';

/**
 * LedgerService
 *
 * The single chokepoint for all money movement against FOSA/BOSA accounts.
 * Every call writes both:
 *   1. The operational Transaction row (balanceBefore/balanceAfter on Account) — the
 *      member-facing statement source.
 *   2. A paired JournalEntry + GLPosting row — the double-entry GL source.
 * in one Serializable DB transaction, so the GL can never drift from live balances
 * (see Phase 0 audit: previously only matchMpesaTransaction() did this).
 *
 * GL account codes are resolved from the chart of accounts seeded by
 * AccountingService.seedDefaultChartOfAccounts() — see resolveGlCodes().
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  /** MVP chart-of-accounts mapping. Must match prisma/seed-gl-accounts.ts codes. */
  private readonly GL_CODES = {
    CASH: '1000',
    LOAN_RECEIVABLE: '1300',
    FOSA_DEPOSITS: '2300',
    BOSA_DEPOSITS: '2400',
    INTEREST_INCOME: '4000',
    FEE_INCOME: '4300',
    PENALTY_INCOME: '4200',
  } as const;

  /**
   * Operational Transaction.type has no 1:1 counterpart for every JournalEntryType
   * (e.g. MPESA_DEPOSIT is still just a DEPOSIT from the member-statement's point of
   * view) — this maps the GL-level type down to the coarser statement-level type.
   */
  private readonly JOURNAL_TO_TRANSACTION_TYPE: Partial<Record<JournalEntryType, TransactionType>> = {
    [JournalEntryType.DEPOSIT]: TransactionType.DEPOSIT,
    [JournalEntryType.MPESA_DEPOSIT]: TransactionType.DEPOSIT,
    [JournalEntryType.WITHDRAWAL]: TransactionType.WITHDRAWAL,
    [JournalEntryType.TRANSFER]: TransactionType.TRANSFER,
    [JournalEntryType.DIVIDEND_PAYOUT]: TransactionType.DIVIDEND_PAYOUT,
    [JournalEntryType.FEE_CHARGE]: TransactionType.FEE_CHARGE,
    [JournalEntryType.LOAN_DISBURSEMENT]: TransactionType.LOAN_DISBURSEMENT,
  };

  /**
   * Memoized per-tenant SYSTEM user ID (see resolveSystemActorId()) — avoids a DB
   * round trip on every automated posting (e.g. per M-Pesa callback). Caches the
   * in-flight promise (not just the resolved value) so concurrent lookups for the
   * same tenant before the first completes still dedupe to one query.
   */
  private readonly systemUserIdCache = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─── SINGLE-ACCOUNT ENTRY (deposit / withdrawal / mpesa deposit / fee / dividend) ──

  /**
   * Post a single-account ledger entry: one Transaction (operational) + one
   * JournalEntry/GLPosting (GL) pair.
   *
   * Idempotent: replaying the same (tenantId, reference) returns the original
   * result without writing anything new.
   *
   * `actorId` is optional for system-triggered callers (M-Pesa webhooks, interest
   * accrual, scheduled jobs) that have no human actor to attribute the posting to.
   * When omitted, falls back to the tenant's seeded SYSTEM user (see
   * AccountingService.ensureSystemUser() and resolveSystemActorId() below) —
   * JournalEntry.createdById/approvedById are non-nullable FKs to User, so this
   * fallback must resolve to a real row, not a sentinel string.
   *
   * `tx` is optional: pass the caller's own Prisma.TransactionClient when this
   * posting must be atomic with other writes in the same unit of work (e.g. a loan
   * status update alongside disbursement) — postEntry() then participates in that
   * transaction instead of opening its own. When omitted (the common case, e.g.
   * AccountsService.deposit/withdraw), postEntry() opens its own Serializable
   * transaction, exactly as before. Note: the internal audit-log write is skipped
   * when `tx` is supplied — the caller is expected to write its own audit entry
   * inside that same transaction (see LoansService.disburse() for the pattern),
   * since firing it here would record an event that might still be rolled back by
   * a later step in the caller's transaction.
   */
  async postEntry(params: {
    tenantId: string;
    reference: string;
    journalType: JournalEntryType;
    accountId: string;
    amount: Decimal;
    direction: Direction;
    actorId?: string;
    description?: string;
    linkedTransactionId?: string;
    loanId?: string;
    tx?: PrismaTx;
  }): Promise<{ transaction: Transaction; journalEntry: JournalEntry }> {
    const { tenantId, journalType, accountId, direction, linkedTransactionId, loanId } = params;

    const actorId = params.actorId ?? (await this.resolveSystemActorId(tenantId));

    const amount = params.amount.toDecimalPlaces(4);
    if (amount.lte(0)) throw new BadRequestException('Amount must be positive');

    const description = params.description ?? journalType;
    const reference = params.reference;

    const runBody = (tx: PrismaTx) =>
      this.postEntryBody(tx, {
        tenantId,
        reference,
        journalType,
        accountId,
        amount,
        direction,
        actorId,
        description,
        linkedTransactionId,
        loanId,
      });

    const result = params.tx
      ? await runBody(params.tx)
      : await this.prisma.$transaction((tx) => runBody(tx), { isolationLevel: 'Serializable' });

    if (!result.replayed && !params.tx) {
      this.audit
        .create({
          tenantId,
          actorId,
          action: 'LEDGER_POST_ENTRY',
          entityType: 'Transaction',
          entityId: result.transaction.id,
          newValue: {
            journalType,
            accountId,
            direction,
            amount: amount.toNumber(),
            reference,
          },
        })
        .catch((e: unknown) => this.logger.error('Audit write failed for LEDGER_POST_ENTRY', e));
    }

    return { transaction: result.transaction, journalEntry: result.journalEntry };
  }

  private async postEntryBody(
    tx: PrismaTx,
    params: {
      tenantId: string;
      reference: string;
      journalType: JournalEntryType;
      accountId: string;
      amount: Decimal;
      direction: Direction;
      actorId: string;
      description: string;
      linkedTransactionId?: string;
      loanId?: string;
    },
  ): Promise<{ transaction: Transaction; journalEntry: JournalEntry; replayed: boolean }> {
    const { tenantId, reference, journalType, accountId, amount, direction, actorId, description, linkedTransactionId, loanId } = params;

    // 1. Idempotency check
    const existing = await tx.transaction.findFirst({ where: { tenantId, reference } });
    if (existing) {
      const existingEntry = await tx.journalEntry.findFirst({
        where: { tenantId, referenceType: 'TRANSACTION', referenceId: existing.id },
      });
      if (!existingEntry) {
        throw new ConflictException(
          `Transaction ${reference} exists without a linked journal entry — ledger is inconsistent`,
        );
      }
      return { transaction: existing, journalEntry: existingEntry, replayed: true };
    }

    // 2. Balance + minimum-balance floor enforcement (atomic conditional update)
    const { balanceBefore, balanceAfter, accountType } = await this.applyBalanceChange(tx, {
      tenantId,
      accountId,
      amount,
      direction,
    });

    // 3. Operational Transaction row (member-statement source of truth)
    const transactionType = this.JOURNAL_TO_TRANSACTION_TYPE[journalType];
    if (!transactionType) {
      throw new BadRequestException(
        `postEntry: no TransactionType mapping for journalType ${journalType}`,
      );
    }

    const transaction = await tx.transaction.create({
      data: {
        tenantId,
        accountId,
        type: transactionType,
        status: TransactionStatus.COMPLETED,
        amount: amount.toString(),
        balanceBefore: balanceBefore.toDecimalPlaces(4).toString(),
        balanceAfter: balanceAfter.toString(),
        reference,
        description,
        processedBy: actorId,
        ...(linkedTransactionId && { linkedTransactionId }),
        ...(loanId && { loanId }),
      },
    });

    // 4. GL resolution + double-entry write (GL source of truth)
    const { debitCode, creditCode } = this.resolveGlCodes(accountType, journalType, direction);
    const { debitAccount, creditAccount } = await this.findGlAccountPair(
      tx,
      tenantId,
      debitCode,
      creditCode,
    );

    const journalEntry = await tx.journalEntry.create({
      data: {
        tenantId,
        entryNumber: `JE-LEDGER-${reference}`,
        type: journalType,
        status: JournalEntryStatus.POSTED,
        description,
        referenceType: 'TRANSACTION',
        referenceId: transaction.id,
        totalAmount: amount.toString(),
        createdById: actorId,
        approvedById: actorId,
        approvalNotes: 'System-posted via LedgerService.postEntry()',
        postedAt: new Date(),
        postings: {
          create: [
            {
              debitAccountId: debitAccount.id,
              creditAccountId: creditAccount.id,
              amount: amount.toString(),
              description,
            },
          ],
        },
      },
    });

    return { transaction, journalEntry, replayed: false };
  }

  // ─── INTERNAL TRANSFER (FOSA <-> BOSA) ────────────────────────────────────────

  /**
   * Post an internal transfer between two accounts of the same tenant.
   *
   * Writes TWO Transaction rows (one per account, linked via linkedTransactionId)
   * but exactly ONE JournalEntry/GLPosting pair — debiting the source account's
   * liability GL code and crediting the destination's. No Cash GL account is
   * touched since no money leaves the SACCO.
   *
   * Deliberate deviation from a literal "call postEntry() twice": doing so would
   * each independently debit/credit the same liability pair, double-counting the
   * GL impact of a single economic event. Both operational legs are still written
   * (via the same applyBalanceChange() helper postEntry() uses), just under one
   * combined GL entry.
   */
  async postInternalTransfer(params: {
    tenantId: string;
    fromAccountId: string;
    toAccountId: string;
    amount: Decimal;
    reference: string;
    actorId: string;
    description?: string;
  }): Promise<{ fromTransaction: Transaction; toTransaction: Transaction; journalEntry: JournalEntry }> {
    const { tenantId, fromAccountId, toAccountId, reference, actorId } = params;

    const amount = params.amount.toDecimalPlaces(4);
    if (amount.lte(0)) throw new BadRequestException('Amount must be positive');
    if (fromAccountId === toAccountId) {
      throw new BadRequestException('Cannot transfer an account to itself');
    }

    const description = params.description ?? 'Internal transfer';
    const srcReference = `${reference}-SRC`;
    const dstReference = `${reference}-DST`;

    const result = await this.prisma.$transaction(
      async (tx) => {
        // 1. Idempotency check
        const existingSrc = await tx.transaction.findFirst({ where: { tenantId, reference: srcReference } });
        if (existingSrc) {
          const existingDst = await tx.transaction.findFirst({ where: { tenantId, reference: dstReference } });
          const existingEntry = await tx.journalEntry.findFirst({
            where: { tenantId, referenceType: 'TRANSACTION', referenceId: existingSrc.id },
          });
          if (!existingDst || !existingEntry) {
            throw new ConflictException(
              `Transfer ${reference} exists partially — ledger is inconsistent`,
            );
          }
          return {
            fromTransaction: existingSrc,
            toTransaction: existingDst,
            journalEntry: existingEntry,
            replayed: true,
          };
        }

        // 2. Both operational legs (source debit, destination credit)
        const fromChange = await this.applyBalanceChange(tx, {
          tenantId,
          accountId: fromAccountId,
          amount,
          direction: 'DEBIT',
        });
        const toChange = await this.applyBalanceChange(tx, {
          tenantId,
          accountId: toAccountId,
          amount,
          direction: 'CREDIT',
        });

        const fromTransaction = await tx.transaction.create({
          data: {
            tenantId,
            accountId: fromAccountId,
            type: TransactionType.TRANSFER,
            status: TransactionStatus.COMPLETED,
            amount: amount.toString(),
            balanceBefore: fromChange.balanceBefore.toDecimalPlaces(4).toString(),
            balanceAfter: fromChange.balanceAfter.toString(),
            reference: srcReference,
            description,
            processedBy: actorId,
          },
        });

        const toTransaction = await tx.transaction.create({
          data: {
            tenantId,
            accountId: toAccountId,
            type: TransactionType.TRANSFER,
            status: TransactionStatus.COMPLETED,
            amount: amount.toString(),
            balanceBefore: toChange.balanceBefore.toDecimalPlaces(4).toString(),
            balanceAfter: toChange.balanceAfter.toString(),
            reference: dstReference,
            description,
            processedBy: actorId,
            linkedTransactionId: fromTransaction.id,
          },
        });

        await tx.transaction.update({
          where: { id: fromTransaction.id },
          data: { linkedTransactionId: toTransaction.id },
        });

        // 3. One combined GL entry: debit source liability, credit destination liability
        const { debitCode, creditCode } = this.resolveGlCodes(
          fromChange.accountType,
          JournalEntryType.TRANSFER,
          'DEBIT',
          toChange.accountType,
        );
        const { debitAccount, creditAccount } = await this.findGlAccountPair(
          tx,
          tenantId,
          debitCode,
          creditCode,
        );

        const journalEntry = await tx.journalEntry.create({
          data: {
            tenantId,
            entryNumber: `JE-LEDGER-${reference}`,
            type: JournalEntryType.TRANSFER,
            status: JournalEntryStatus.POSTED,
            description,
            referenceType: 'TRANSACTION',
            referenceId: fromTransaction.id,
            totalAmount: amount.toString(),
            createdById: actorId,
            approvedById: actorId,
            approvalNotes: 'System-posted via LedgerService.postInternalTransfer()',
            postedAt: new Date(),
            postings: {
              create: [
                {
                  debitAccountId: debitAccount.id,
                  creditAccountId: creditAccount.id,
                  amount: amount.toString(),
                  description,
                },
              ],
            },
          },
        });

        return {
          fromTransaction: { ...fromTransaction, linkedTransactionId: toTransaction.id },
          toTransaction,
          journalEntry,
          replayed: false,
        };
      },
      { isolationLevel: 'Serializable' },
    );

    if (!result.replayed) {
      this.audit
        .create({
          tenantId,
          actorId,
          action: 'LEDGER_POST_ENTRY',
          entityType: 'Transaction',
          entityId: result.fromTransaction.id,
          newValue: {
            journalType: JournalEntryType.TRANSFER,
            fromAccountId,
            toAccountId,
            amount: amount.toNumber(),
            reference,
          },
        })
        .catch((e: unknown) => this.logger.error('Audit write failed for LEDGER_POST_ENTRY (transfer)', e));
    }

    return {
      fromTransaction: result.fromTransaction as Transaction,
      toTransaction: result.toTransaction,
      journalEntry: result.journalEntry,
    };
  }

  // ─── LOAN REPAYMENT WATERFALL LEG (GL-only, no Account touched) ───────────────

  /**
   * Post the GL side of one leg of a loan repayment waterfall (penalty / interest /
   * principal). Unlike postEntry(), this touches NO Account balance — repayment
   * money arrives externally (M-Pesa/cash) and is applied directly against the
   * loan's own fields (Loan.arrearsAmount/accruedInterest/outstandingBalance), never
   * through the member's FOSA balance. Only genuine overpayment (credited into FOSA)
   * belongs in postEntry(); these three legs are Cash-vs-Income/Receivable only:
   *   PENALTY:   debit CASH, credit PENALTY_INCOME
   *   INTEREST:  debit CASH, credit INTEREST_INCOME
   *   PRINCIPAL: debit CASH, credit LOAN_RECEIVABLE
   *
   * `tx` is REQUIRED (not optional, unlike postEntry) — the waterfall's Loan-field
   * updates, LoanRepayment schedule allocation, and every leg's GL posting must
   * commit or roll back together in the caller's own Serializable transaction.
   *
   * Idempotent on (tenantId, entryNumber derived from `reference`) — but note the
   * *caller* (LoanRepaymentService) already guards against reprocessing the same
   * repayment event via its own top-level reference check before ever reaching the
   * waterfall, so this is defense-in-depth rather than the primary guard. `reference`
   * must be scoped to the specific repayment event (e.g. `${input.reference}-PENALTY`),
   * NOT just the loan (`LOAN-{loanId}-PENALTY` would collide across a loan's many
   * separate repayments over its life, silently dropping real GL entries).
   *
   * No internal audit-log write — LoanRepaymentService writes one consolidated
   * 'LOAN.REPAYMENT.WATERFALL' audit entry covering all legs after its transaction
   * commits.
   */
  async postLoanRepaymentLegEntry(params: {
    tx: PrismaTx;
    tenantId: string;
    reference: string;
    leg: 'PENALTY' | 'INTEREST' | 'PRINCIPAL';
    amount: Decimal;
    transactionId: string;
    actorId: string;
    description?: string;
  }): Promise<{ journalEntry: JournalEntry; replayed: boolean }> {
    return this.postGlOnlyLegEntry({
      ...params,
      debitCode: this.GL_CODES.CASH,
      description: params.description ?? `Loan repayment — ${params.leg.toLowerCase()} allocation`,
      approvalNotes: 'System-posted via LedgerService.postLoanRepaymentLegEntry()',
    });
  }

  /**
   * Post the GL side of one leg of a *manually recorded* (teller) loan repayment,
   * where the money is deducted directly from the member's own FOSA/BOSA balance —
   * unlike postLoanRepaymentLegEntry() (external M-Pesa/cash), the debit side here
   * is the member's deposit-liability code, not CASH:
   *   PENALTY:   debit FOSA/BOSA_DEPOSITS, credit PENALTY_INCOME
   *   INTEREST:  debit FOSA/BOSA_DEPOSITS, credit INTEREST_INCOME
   *   PRINCIPAL: debit FOSA/BOSA_DEPOSITS, credit LOAN_RECEIVABLE
   *
   * Deliberately does NOT itself touch Account.balance or applyBalanceChange() —
   * LoansService.repay() decrements the FOSA balance exactly ONCE, for the total
   * repayment amount, via its own existing FOR-UPDATE-locked logic; calling
   * postEntry() here too would debit FOSA_DEPOSITS a second time for the same
   * money. Summed across the (up to 3) legs, this method's debit total equals that
   * one balance decrease — consistent books, no suspense account needed.
   */
  async postAccountSourcedRepaymentLegEntry(params: {
    tx: PrismaTx;
    tenantId: string;
    reference: string;
    leg: 'PENALTY' | 'INTEREST' | 'PRINCIPAL';
    amount: Decimal;
    accountType: AccountType;
    transactionId: string;
    actorId: string;
    description?: string;
  }): Promise<{ journalEntry: JournalEntry; replayed: boolean }> {
    return this.postGlOnlyLegEntry({
      ...params,
      debitCode: this.memberDepositsCode(params.accountType),
      description: params.description ?? `Loan repayment (FOSA-sourced) — ${params.leg.toLowerCase()} allocation`,
      approvalNotes: 'System-posted via LedgerService.postAccountSourcedRepaymentLegEntry()',
    });
  }

  /**
   * Shared implementation for both loan-repayment leg postings above: one
   * GL-only JournalEntry/GLPosting pair, debiting `debitCode` and crediting the
   * leg-appropriate income/receivable code. No Account or operational Transaction
   * row is touched — see the two public methods' docs for why.
   */
  private async postGlOnlyLegEntry(params: {
    tx: PrismaTx;
    tenantId: string;
    reference: string;
    leg: 'PENALTY' | 'INTEREST' | 'PRINCIPAL';
    amount: Decimal;
    debitCode: string;
    transactionId: string;
    actorId: string;
    description: string;
    approvalNotes: string;
  }): Promise<{ journalEntry: JournalEntry; replayed: boolean }> {
    const { tx, tenantId, reference, leg, debitCode, transactionId, actorId, description, approvalNotes } = params;

    const amount = params.amount.toDecimalPlaces(4);
    if (amount.lte(0)) throw new BadRequestException('Amount must be positive');

    const entryNumber = `JE-LEDGER-${reference}`;

    const existing = await tx.journalEntry.findFirst({ where: { tenantId, entryNumber } });
    if (existing) {
      return { journalEntry: existing, replayed: true };
    }

    const creditCode =
      leg === 'PENALTY'
        ? this.GL_CODES.PENALTY_INCOME
        : leg === 'INTEREST'
          ? this.GL_CODES.INTEREST_INCOME
          : this.GL_CODES.LOAN_RECEIVABLE;

    const { debitAccount, creditAccount } = await this.findGlAccountPair(
      tx,
      tenantId,
      debitCode,
      creditCode,
    );

    const journalEntry = await tx.journalEntry.create({
      data: {
        tenantId,
        entryNumber,
        type: JournalEntryType.LOAN_REPAYMENT,
        status: JournalEntryStatus.POSTED,
        description,
        referenceType: 'TRANSACTION',
        referenceId: transactionId,
        totalAmount: amount.toString(),
        createdById: actorId,
        approvedById: actorId,
        approvalNotes,
        postedAt: new Date(),
        postings: {
          create: [
            {
              debitAccountId: debitAccount.id,
              creditAccountId: creditAccount.id,
              amount: amount.toString(),
              description,
            },
          ],
        },
      },
    });

    return { journalEntry, replayed: false };
  }

  // ─── SHARED HELPERS ────────────────────────────────────────────────────────────

  /**
   * Resolve the tenant's SYSTEM user ID for automated postEntry() calls with no
   * human actor, memoized per tenant for the lifetime of this service instance.
   * Throws if the tenant hasn't been provisioned yet (AccountingService.
   * provisionTenantAccounting() / ensureSystemUser() seeds this on tenant creation).
   */
  private async resolveSystemActorId(tenantId: string): Promise<string> {
    const cached = this.systemUserIdCache.get(tenantId);
    if (cached) return cached;

    const lookup = this.prisma.user
      .findFirst({ where: { tenantId, role: UserRole.SYSTEM }, select: { id: true } })
      .then((user) => {
        if (!user) {
          this.systemUserIdCache.delete(tenantId);
          throw new NotFoundException(
            `Tenant ${tenantId} has no SYSTEM user provisioned — run AccountingService.ensureSystemUser() first`,
          );
        }
        return user.id;
      });

    this.systemUserIdCache.set(tenantId, lookup);
    return lookup;
  }

  /**
   * Atomically apply a balance change to one account, enforcing its
   * minimum-balance floor (unless allowsNegative) via a conditional WHERE clause
   * on the same updateMany() call — a compare-and-swap that avoids the
   * check-then-write race a separate SELECT + UPDATE would have.
   */
  private async applyBalanceChange(
    tx: PrismaTx,
    params: { tenantId: string; accountId: string; amount: Decimal; direction: Direction },
  ): Promise<{ balanceBefore: Decimal; balanceAfter: Decimal; accountType: AccountType }> {
    const { tenantId, accountId, amount, direction } = params;

    const account = await tx.account.findFirst({
      where: { id: accountId, tenantId, isActive: true },
      select: { balance: true, minimumBalance: true, allowsNegative: true, accountType: true },
    });
    if (!account) {
      throw new NotFoundException(`Account ${accountId} not found or inactive in this tenant`);
    }

    const balanceBefore = new Decimal(account.balance.toString());
    const delta = direction === 'CREDIT' ? amount : amount.negated();
    const balanceAfter = balanceBefore.plus(delta).toDecimalPlaces(4);

    const where: Prisma.AccountWhereInput = { id: accountId, tenantId, isActive: true };
    if (direction === 'DEBIT' && !account.allowsNegative) {
      // balance - amount >= minimumBalance  <=>  balance >= minimumBalance + amount
      const minimumBalance = new Decimal(account.minimumBalance.toString());
      where.balance = { gte: minimumBalance.plus(amount).toDecimalPlaces(4).toString() };
    }

    const updated = await tx.account.updateMany({
      where,
      data: {
        balance:
          direction === 'CREDIT'
            ? { increment: amount.toString() }
            : { decrement: amount.toString() },
        version: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      throw new BadRequestException(
        'Insufficient funds or below minimum balance requirement, or concurrent modification',
      );
    }

    return { balanceBefore, balanceAfter, accountType: account.accountType };
  }

  /**
   * Resolve which GL account codes a single-account posting should hit.
   *
   * DEPOSIT / MPESA_DEPOSIT: debit CASH, credit the account's deposit-liability code.
   * WITHDRAWAL: the reverse.
   * LOAN_DISBURSEMENT: debit LOAN_RECEIVABLE (asset), credit the account's deposit-
   * liability code — the member's FOSA balance increases, but no cash leaves the
   * SACCO yet (that happens on a later withdrawal).
   * FEE_CHARGE: debit the account's deposit-liability code (balance decreases),
   * credit FEE_INCOME.
   * TRANSFER: debit/credit two *different* accounts' liability codes (no Cash) —
   * `counterpartyAccountType` identifies the other leg.
   */
  private resolveGlCodes(
    accountType: AccountType,
    journalType: JournalEntryType,
    direction: Direction,
    counterpartyAccountType?: AccountType,
  ): { debitCode: string; creditCode: string } {
    const ownCode = this.memberDepositsCode(accountType);

    if (journalType === JournalEntryType.TRANSFER) {
      if (!counterpartyAccountType) {
        throw new BadRequestException('resolveGlCodes: TRANSFER requires a counterparty account type');
      }
      const counterpartyCode = this.memberDepositsCode(counterpartyAccountType);
      return direction === 'CREDIT'
        ? { debitCode: counterpartyCode, creditCode: ownCode }
        : { debitCode: ownCode, creditCode: counterpartyCode };
    }

    switch (journalType) {
      case JournalEntryType.DEPOSIT:
      case JournalEntryType.MPESA_DEPOSIT:
        return { debitCode: this.GL_CODES.CASH, creditCode: ownCode };
      case JournalEntryType.WITHDRAWAL:
        return { debitCode: ownCode, creditCode: this.GL_CODES.CASH };
      case JournalEntryType.LOAN_DISBURSEMENT:
        return { debitCode: this.GL_CODES.LOAN_RECEIVABLE, creditCode: ownCode };
      case JournalEntryType.FEE_CHARGE:
        return { debitCode: ownCode, creditCode: this.GL_CODES.FEE_INCOME };
      default:
        throw new BadRequestException(
          `resolveGlCodes: unsupported journalType ${journalType} for LedgerService.postEntry()`,
        );
    }
  }

  private memberDepositsCode(accountType: AccountType): string {
    return accountType === AccountType.FOSA ? this.GL_CODES.FOSA_DEPOSITS : this.GL_CODES.BOSA_DEPOSITS;
  }

  private async findGlAccountPair(
    tx: PrismaTx,
    tenantId: string,
    debitCode: string,
    creditCode: string,
  ): Promise<{ debitAccount: { id: string }; creditAccount: { id: string } }> {
    const glAccounts = await tx.gLAccount.findMany({
      where: { tenantId, code: { in: [debitCode, creditCode] }, isActive: true },
      select: { id: true, code: true },
    });
    const debitAccount = glAccounts.find((g) => g.code === debitCode);
    const creditAccount = glAccounts.find((g) => g.code === creditCode);
    if (!debitAccount || !creditAccount) {
      throw new BadRequestException(
        `Required GL accounts (${debitCode}/${creditCode}) are not configured for this tenant — ` +
          'run AccountingService.seedDefaultChartOfAccounts() first',
      );
    }
    return { debitAccount, creditAccount };
  }
}
