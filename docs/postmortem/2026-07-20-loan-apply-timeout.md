# Postmortem: Loan Application Failure Under DB Latency (2026-07-20)

## Summary

A member's loan application to the Beba SACCO production API (`POST /api/v1/members/loans/apply`,
via the `kolwa.mwaloni.com` frontend) failed with an HTTP 500 after ~5.16 seconds. Root-cause
investigation identified two independent, compounding defects in
`LoanApplicationService._doMemberApply()`: an interactive database transaction with no explicit
timeout override running against Prisma's unconfigured 5000ms default, and an idempotency-key
release path that only covered a few named exception types — leaving the affected member unable to
retry their own application for up to 24 hours. The proximate trigger was a period of Neon Postgres
compute-quota exhaustion (since resolved by the account owner), which slowed an already
close-to-the-ceiling transaction past its timeout.

## Impact

- **Who:** At least one confirmed member (Kenyan IP, via the `kolwa.mwaloni.com`/Kolwa SACCO
  frontend) had a loan application rejected with "Loan application could not be completed. Please
  retry." Because the idempotency key from that attempt was never released, a retry using the same
  client-generated key would have returned "Loan application is already being processed. Please
  wait." instead of actually retrying — effectively locking that member out of applying for a loan
  under that key until the key's 24-hour TTL expired.
- **Duration:** The underlying DB-latency trigger (Neon compute-quota exhaustion) has been resolved
  by the project owner. The structural fragility (tight transaction timeout, O(N) guarantor
  validation) existed prior to this incident and would recur under any future latency spike
  (additional guarantors on an application scale the risk roughly linearly).
- **Data integrity:** No duplicate loans were created. The `loan_one_open_per_member` partial unique
  index (migration `20260707193000_add_one_open_loan_constraint`) independently guards against this
  regardless of idempotency-key state.

## Timeline

- **Detection:** Render application logs surfaced a `PrismaClientKnownRequestError` from
  `prisma.loan.create()` inside `LoanApplicationService`, referencing an expired Prisma interactive
  transaction (5160ms elapsed against a 5000ms timeout).
- **Diagnosis:** Traced the failure to `_doMemberApply()`'s single interactive transaction, which
  performs ~15-18 sequential DB round-trips for a single-guarantor application (rising with each
  additional guarantor, due to `validateGuarantorEligibilityInTransaction()` running 6 queries per
  guarantor in a loop), with no explicit `timeout`/`maxWait` override — meaning it ran against
  Prisma's stock 5000ms default. Correlated the timing with a concurrent Neon compute-quota
  exhaustion incident, which had already surfaced separately as `P1001` connection errors from a
  scheduled outbox job.
- **Secondary defect found during diagnosis:** `memberApply()`'s catch block released the Redis
  idempotency key only for `BadRequestException`/`ConflictException`/the one-open-loan unique
  constraint violation — not for the generic `InternalServerErrorException` this specific failure
  surfaces as, leaving the key stuck `PROCESSING` for its full 24h TTL.
- **Fix:** (1) explicit `{ maxWait: 10_000, timeout: 30_000 }` on the `_doMemberApply()` transaction;
  (2) rewrote per-guarantor eligibility validation as a fixed 5-query batch, independent of guarantor
  count; (3) made idempotency-key release unconditional on any thrown error, safely wrapped so a
  Redis failure during cleanup can't mask the original error.
- **Deploy:** Pending — see deployment checklist below.

## Root causes

1. **No transaction timeout headroom.** `_doMemberApply()` opened a Prisma interactive transaction
   with no `timeout`/`maxWait` options, so it inherited Prisma's default 5000ms ceiling. The
   transaction's own workload (member/product/account lookups, guarantor eligibility validation,
   loan + guarantor inserts, an audit log write) normally fits comfortably inside that window, but
   with very little margin — any DB latency spike (a Neon cold start, compute-quota throttling,
   cross-region network jitter) could push it over.

2. **O(N) guarantor validation.** `validateGuarantorEligibilityInTransaction()` ran 6 sequential
   queries *per nominated guarantor* (member/user lookup, circular-guarantee check, account lookup,
   defaulted-loan check, tenant-settings lookup, active-guarantee count), all inside the same
   transaction. A 3-guarantor application meant ~18 extra sequential round-trips on top of the
   already-tight budget above.

3. **Idempotency-key release didn't cover this failure mode.** The release condition was scoped to
   three named exception types, on the assumption (per `IdempotencyService.release()`'s own
   docstring) that releasing on ambiguous/transient failures risks a duplicate submission on retry.
   That caution is reasonable in general, but for this specific operation the DB-level
   `loan_one_open_per_member` constraint already provides an independent duplicate-application
   guard — so releasing unconditionally here doesn't reopen the risk the original caution was
   guarding against, while it does prevent stranding a member's retry for a day.

## What went well

- The DB-level `loan_one_open_per_member` constraint meant this failure mode, however disruptive to
  the affected member, never risked actually creating a duplicate loan.
- Structured logging (correlation ID, tenant ID, request ID) made the failing transaction and its
  exact timing immediately identifiable from the Render log line alone.
- The interactive transaction's atomicity worked as designed: on timeout, nothing partial was
  committed.

## What went poorly

- No alerting fired on this error; it was only found by manually reading Render logs.
- The idempotency-key leak meant the member-visible symptom ("please retry") was actively wrong
  advice for anyone reusing their idempotency key, with no operator-facing way to unstick them short
  of a manual Redis key deletion.
- The transaction's round-trip count scales with guarantor count with no upper bound enforced
  elsewhere in the request path (loan products cap `maxGuarantors`, but that cap is per-product
  config, not a hard system-wide ceiling).

## Action items

| Item | Owner | Target date |
|---|---|---|
| Ship the four code fixes in this PR (timeout override, batched guarantor validation, unconditional idempotency release, regression tests) | Backend | 2026-07-21 |
| Run `scripts/` cleanup for the affected member's stuck idempotency key via the new one-time admin endpoint, then remove that endpoint | Backend / Ops | 2026-07-22 |
| Add alerting on `InternalServerErrorException` rate for `/members/loans/apply` (or any interactive-transaction timeout) so this class of failure pages someone instead of waiting for a manual log review | Backend | TBD |
| Audit other `$transaction(...)` call sites for missing timeout config; add TODOs or fix the ones with similarly unbounded round-trip counts | Backend | TBD |
| Audit other idempotency-key acquisitions for the same release-condition gap | Backend | TBD |
| Monitor Neon compute-hour usage against plan limits proactively (dashboard alert before exhaustion, not after) | Infra owner | TBD |

## Lessons learned

- An interactive transaction's round-trip count is a latency budget, not just a correctness
  boundary — every additional per-item loop inside one transaction (like a guarantor list) is a
  scaling risk against whatever timeout is in force, explicit or default.
- A caution like "don't release the idempotency key on ambiguous failures" needs to be re-evaluated
  per call site against what *other* safety nets exist for that specific operation — the general
  advice was right in the abstract, but this specific operation already has a stronger, independent
  guarantee (the DB constraint) that makes the general caution unnecessarily costly here.
- Third-party managed-service quotas (Neon compute hours, in this case) are a real production
  dependency and deserve the same proactive monitoring as any other capacity limit — the first
  signal here was a member-facing failure, not an internal alert.
