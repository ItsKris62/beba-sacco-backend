# Ledger & Accounting Architecture

Reference for anyone touching `LedgerService`, `AccountsService`, `LoansService`, or
`LoanRepaymentService` — the double-entry GL that backs FOSA/BOSA accounts and loan
disbursement/repayment. Written after Phases 0–4 of the ledger integration; read this
before adding a new money-movement code path.

## Two ledgers, on purpose

Every money-moving flow writes to **two** separate tables, and they answer different
questions:

| | Operational ledger | GL (double-entry) |
|---|---|---|
| Tables | `Transaction` (+ `Account.balance`) | `JournalEntry` + `GLPosting` (+ `GLAccount`) |
| Answers | "What's this member's balance? What's on their statement?" | "Is the SACCO's balance sheet correct? Can an auditor trace every shilling?" |
| Written by | `LedgerService.postEntry()` / `postInternalTransfer()` | Same calls, atomically, in the same DB transaction |

They are written together, in the same `$transaction`, specifically so the GL can never
drift from live balances. Before this work, only one code path (manual M-Pesa
reconciliation matching) wrote both — everything else (deposits, withdrawals,
disbursement, repayment) only wrote `Transaction`, leaving the GL incomplete. That gap is
closed as of Phase 4 for every flow except `LoansService.repay()`'s waterfall split,
which Phase 5 also closes (see "Manual vs M-Pesa repayment" below).

## The chart of accounts (`LedgerService.GL_CODES`)

Seeded per-tenant by `AccountingService.seedDefaultChartOfAccounts()` (called from
`provisionTenantAccounting()` on tenant creation). `LedgerService` only knows about the
subset it actively posts to:

| Constant | Code | Type | Used for |
|---|---|---|---|
| `CASH` | `1000` | Asset | External money in/out (M-Pesa, cash deposits/withdrawals, loan repayments) |
| `LOAN_RECEIVABLE` | `1300` | Asset | The SACCO's claim on outstanding loan principal |
| `FOSA_DEPOSITS` | `2300` | Liability | What the SACCO owes FOSA account holders |
| `BOSA_DEPOSITS` | `2400` | Liability | What the SACCO owes BOSA account holders |
| `INTEREST_INCOME` | `4000` | Revenue | Interest recognized on repayment |
| `PENALTY_INCOME` | `4200` | Revenue | Arrears/penalty recognized on repayment |
| `FEE_INCOME` | `4300` | Revenue | Loan processing fees |

If a tenant's chart of accounts is missing one of these codes, every `LedgerService` call
that needs it throws `BadRequestException` rather than silently skipping the posting —
see `findGlAccountPair()`.

## `LedgerService`'s four posting methods

Picking the wrong one for a new flow is the most common way to get this wrong. Ask: **does
this event change an `Account.balance`, and is the money's source Cash or another
Account?**

### `postEntry()` — one Account balance change + one GL pair

Use when a single FOSA/BOSA account's balance actually moves, against a fixed
counterparty (Cash, another account's liability, or an income/receivable code):

- Deposits / withdrawals (`AccountsService.deposit()`/`withdraw()`) — debit/credit `CASH`.
- Loan disbursement principal leg — debit `LOAN_RECEIVABLE`, credit the account's
  deposit-liability code (money enters FOSA, but no cash leaves the SACCO yet).
- Loan disbursement fee leg — debit the deposit-liability code, credit `FEE_INCOME`.
- Genuine repayment overpayment — debit `CASH`, credit the deposit-liability code (this
  is just a deposit).

Idempotent on `(tenantId, reference)`: replaying the same reference returns the original
`{ transaction, journalEntry }` without writing anything new. Accepts an optional `tx` —
when supplied, `postEntry()` participates in the caller's existing transaction instead of
opening its own (needed when the GL write must be atomic with something else, e.g. a
`Loan.status` update). `actorId` is optional; when omitted it resolves to the tenant's
seeded SYSTEM user (see below) since `JournalEntry.createdById`/`approvedById` are
non-nullable FKs to `User`.

### `postInternalTransfer()` — two Account balance changes, one GL pair

FOSA↔BOSA transfers. Writes two linked `Transaction` rows (one per account) but
deliberately only **one** `JournalEntry` — calling `postEntry()` twice here would each
independently post the full debit/credit pair, double-counting one economic event.

### `postLoanRepaymentLegEntry()` — GL-only, money-sourced-externally

For the M-Pesa-triggered repayment waterfall (`LoanRepaymentService.processRepayment()`).
**Touches no `Account.balance` at all** — repayment money arrives externally (M-Pesa) and
is applied straight to the `Loan` row's own fields
(`arrearsAmount`/`accruedInterest`/`outstandingBalance`), never through the member's FOSA
balance. Debits `CASH`, credits `PENALTY_INCOME` / `INTEREST_INCOME` / `LOAN_RECEIVABLE`
depending on the leg. Requires the caller's `tx` (not optional) since it must commit
atomically with the rest of the waterfall.

### `postAccountSourcedRepaymentLegEntry()` — GL-only, money-sourced-from-the-account

For the **manual/teller** repayment flow (`LoansService.repay()`, `POST /loans/:id/repay`).
Same shape as `postLoanRepaymentLegEntry()`, but the money comes from the member's own
FOSA balance, not external cash — so it debits the account's deposit-liability code
(`FOSA_DEPOSITS`/`BOSA_DEPOSITS`, resolved from the passed `accountType`) instead of
`CASH`. **Also touches no `Account.balance`** — `LoansService.repay()` decrements the
balance exactly once, separately, via its own existing `FOR UPDATE`-locked logic, for the
*total* repayment amount. Summed across the (up to three) legs, this method's debit total
equals that one balance decrease. Do not also route the total through `postEntry()` — that
would debit the liability twice for one repayment.

## Manual vs. M-Pesa repayment: why the GL differs

Two structurally different flows exist for repaying a loan, and they need different GL
treatment because the money takes a different path to reach the loan:

| | `LoanRepaymentService.processRepayment()` | `LoansService.repay()` |
|---|---|---|
| Triggered by | M-Pesa callback (`mpesa-callback.processor.ts`) | Teller/admin, `POST /loans/:id/repay` |
| Money source | External (M-Pesa/cash) | Member's own FOSA balance |
| FOSA balance touched? | Only for genuine overpayment | Always, by the full repayment amount |
| Debit side of each leg | `CASH` | `FOSA_DEPOSITS` (or `BOSA_DEPOSITS`) |
| LedgerService method | `postLoanRepaymentLegEntry()` | `postAccountSourcedRepaymentLegEntry()` |

Both split the payment through the same SASRA waterfall (penalty → interest → principal)
and both post one GL-only `JournalEntry` per non-zero leg.

**Idempotency reference scoping — a real bug to avoid**: a leg's GL reference must be
scoped to the *specific repayment event*, e.g. `${input.reference}-PENALTY`, never just
`${loanId}-PENALTY`. A loan is repaid many times over its life; a loan-scoped reference
means the second repayment's penalty leg collides with the first's and gets silently
treated as an idempotent replay — the entry doesn't get created, and real money movement
goes unrecorded in the GL. Both repayment services get this right today; keep it that way
in anything new.

## The SYSTEM user

`JournalEntry.createdById`/`approvedById` are non-nullable FKs to `User` — there is no
"NULL means system" escape hatch. Every tenant gets a locked-down `SYSTEM` user
(`role: SYSTEM`, `accountStatus: SUSPENDED`, random unusable password) seeded by
`AccountingService.ensureSystemUser()` on tenant creation. `LedgerService.postEntry()`
falls back to it when called with no `actorId` (e.g. from a future fully-automated M-Pesa
deposit handler), memoizing the lookup per tenant in an in-memory `Map` of in-flight
promises so concurrent callers dedupe to one query. `postLoanRepaymentLegEntry()` /
`postAccountSourcedRepaymentLegEntry()` don't need this fallback — they always run inside
a caller that already has a real `processedBy`/`actorId`.

## Concurrency & idempotency patterns

- **Balance mutation**: `applyBalanceChange()` does a single conditional `updateMany()` —
  the `WHERE` clause encodes both existence (`id`, `tenantId`, `isActive`) and, for debits,
  the minimum-balance floor (`balance >= minimumBalance + amount`, skipped if
  `allowsNegative`). This is a compare-and-swap: no separate `SELECT ... FOR UPDATE` is
  needed, and `updated.count === 0` distinguishes "someone else already claimed this row"
  from "insufficient funds" only in that both produce the same `BadRequestException` — by
  design, since from the caller's perspective both mean "retry or reject," not "crash."
- **Idempotency**: every `postEntry()`/`postInternalTransfer()` call is keyed on
  `(tenantId, reference)` against the `Transaction` table; every GL-only leg call is keyed
  on a derived `entryNumber` (`JE-LEDGER-${reference}`) against `JournalEntry`. Replaying
  a known reference returns the original result instead of writing anything new or
  throwing.
- **Minimum balance floor**: snapshotted onto `Account.minimumBalance`/`allowsNegative`
  from the tenant's `AccountTypePolicy` at account-creation time
  (`AccountsService.create()`) — editing the policy later does not retroactively change
  existing accounts.

## Known gaps (as of Phase 5)

- `AccountTypePolicy` is tenant-wide per account type (one row for all FOSA accounts, one
  for all BOSA accounts) — there's no per-member override.
- The GL's chart of accounts is a flat MVP mapping (`GL_CODES`) hardcoded in
  `LedgerService`, not read from the tenant's actual `GLAccount` hierarchy beyond code
  lookup. Multi-loan-product receivable sub-accounts (`1301`, `1302`, seeded but unused)
  aren't wired to anything yet — all loan receivable postings use the generic `1300`.
