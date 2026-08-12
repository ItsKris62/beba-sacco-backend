# Member FOSA-to-M-Pesa Withdrawal Reconciliation Runbook

Scope: Kolwa Beba SACCO member withdrawals from FOSA to M-Pesa via Mwaloni B2C.

Hard rules:

- Never directly mutate `Account.balance`.
- Never auto-refund ambiguous B2C outcomes.
- Never blindly resend an uncertain provider transaction.
- Use the admin reconciliation endpoints and audit trail. Do not resolve cases with raw SQL except formal disaster recovery.

## Case A - Normal Pending Withdrawal

Check `/admin/reconciliations/pending` and the M-Pesa transaction by reference. A recent `PENDING` row with a provider submission attempt inside the SLA is normal. Wait for callback or scheduled reconciliation.

## Case B - `RECON_PENDING`

`RECON_PENDING` means the provider outcome is delayed, ambiguous, mismatched, or unavailable. Funds may still be debited because the member may still receive M-Pesa. Do not reverse until provider failure or non-payment is confirmed.

Use `POST /admin/reconciliations/:transactionId/refresh-status` to query Mwaloni and apply safe status logic.

## Case C - Confirmed Provider Failure

If Mwaloni or formal provider evidence confirms the payout failed or could not have occurred, use:

`POST /admin/reconciliations/:transactionId/reverse`

Required: reason and evidence reference. The system reverses through `LedgerService.reverseTransaction()`.

## Case D - Provider Success but Callback Missing

Use `refresh-status`. If Mwaloni returns success and correlation checks pass, the transaction moves to `COMPLETED`. No second debit and no second payout are created.

## Case E - Callback Mismatch

Mismatch means amount, phone, or provider reference did not match local records. Do not manually complete based only on the callback. Escalate to finance plus engineering/provider support.

## Case F - Dead-Letter Payout

Dead-letter payout intent means the dispatch job exhausted retries. Inspect the payload intent, linked ledger transaction, and provider submission state from `/admin/reconciliations/pending`. Do not resend if provider submission was attempted or unknown.

## Case G - Manual Reversal

Only `ACCOUNTANT`, `MANAGER`, or `SUPER_ADMIN` may perform financial resolution. Capture provider/support reference and reason. Reversal uses ledger service only.

## Case H - Suspected Duplicate Provider Payment

Do not reverse, refund, or resend. Preserve evidence, open provider support case, and escalate. Use manual completion/reversal only after the provider outcome is known.

## Case I - Provider Outage

Keep withdrawals in non-terminal reconciliation state. Automated retries are bounded. Monitor:

- `beba_b2c_reconciliation_failure_total`
- `beba_b2c_provider_send_ambiguous_total`
- `beba_b2c_recon_oldest_age_seconds`
- `beba_b2c_dead_letter_count`

Communicate delayed confirmation to operations. Member-facing messaging is Phase 3.
