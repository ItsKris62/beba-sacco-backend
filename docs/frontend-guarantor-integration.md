# Frontend Guarantor Integration

## Phase 1 — ID Lookup and Loan Application

### `POST /api/members/guarantors/lookup`

Headers: `Authorization: Bearer <memberJwt>`, `X-Tenant-ID: <tenantId>`

Request:

```json
{ "idNumber": "87654321" }
```

Response:

```json
{
  "memberId": "uuid",
  "name": "Jane Member",
  "kycStatus": "KYC_VERIFIED",
  "availableBalance": 60000,
  "tenantId": "tenant-uuid"
}
```

UI mapping: show National ID input only; never search by username or display name. Add selected `memberId` to the loan form after lookup succeeds.

### `POST /api/members/loans/apply`

Headers: `Authorization`, `X-Tenant-ID`, `X-Idempotency-Key: <uuid>`

Request:

```json
{
  "loanProductId": "uuid",
  "principalAmount": 30000,
  "tenureMonths": 6,
  "purpose": "School fees",
  "guarantorIds": ["lookup-member-id"]
}
```

UI mapping: disable submit while processing; preserve the same `X-Idempotency-Key` on retry.

## Phase 2 — Guarantor Dashboard and Decisions

### `GET /api/members/guarantor/requests`

Response item:

```json
{
  "loanId": "uuid",
  "loanNumber": "LN-2026-000001",
  "applicantName": "Member User",
  "amount": 30000,
  "guaranteedAmount": 30000,
  "status": "PENDING",
  "purpose": "School fees"
}
```

UI mapping: add a dedicated Guarantor menu with Pending, Accepted, Declined tabs. Pending rows show Accept and Decline buttons.

### `POST /api/members/loans/:id/guarantor-response`

Headers: `Authorization`, `X-Tenant-ID`, `X-Idempotency-Key`

Request:

```json
{ "action": "ACCEPT", "digitalAcknowledgment": true, "notes": "I accept" }
```

Decline request:

```json
{ "action": "DECLINE", "digitalAcknowledgment": true, "notes": "Insufficient capacity" }
```

### `PATCH /api/admin/loans/:loanId/guarantors/:guarantorId/status`

Manager-only request:

```json
{ "action": "DECLINE", "notes": "Member confirmed by phone" }
```

## Phase 3 — Holds, Coverage and Disbursement Gate

Accepting a request locks `guaranteedAmount` against the guarantor FOSA account. Decline, expiry, loan rejection, and full repayment release holds. Admin disbursement is blocked unless all guarantors are accepted and accepted coverage is at least `loanAmount * guarantorCoverageRatio`.

## Error Code to Banner Mapping

| Error message prefix | Banner |
| --- | --- |
| `INVALID_ID_NUMBER` | Enter a valid 7–8 digit Kenyan National ID. |
| `GUARANTOR_NOT_FOUND` | No active SACCO member found for that National ID. |
| `SELF_GUARANTEE_NOT_ALLOWED` | You cannot guarantee your own loan. |
| `GUARANTOR_KYC_NOT_VERIFIED` | The selected guarantor must complete KYC first. |
| `GUARANTOR_INSUFFICIENT_FUNDS` | Guarantor available balance is below the guaranteed amount. |
| `INSUFFICIENT_COVERAGE` | Add guarantors until coverage meets product requirements. |
| `DISBURSEMENT_BLOCKED_GUARANTORS_PENDING` | All guarantors must accept before disbursement. |
| `DISBURSEMENT_BLOCKED_COVERAGE` | Accepted guarantor coverage is insufficient. |

## Polling Strategy

After loan application, poll `GET /api/members/loans/:id/guarantor-status` every 20 seconds for up to 72 hours, stopping when status changes from `PENDING_GUARANTORS` to `PENDING_REVIEW` or `REJECTED_GUARANTOR_DECLINE`. Guarantor dashboards should poll `GET /api/members/guarantor/requests` every 30 seconds while visible and refresh immediately after Accept or Decline.