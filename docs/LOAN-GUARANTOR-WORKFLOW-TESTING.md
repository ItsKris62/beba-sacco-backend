# Loan Guarantor Workflow Testing

Manual verification guide for Render-compatible Node.js deployments. These steps use the existing `Loan` and `LoanGuarantor` tables and do not require Docker.

## Setup

Seed or create:

- 1 applicant member with approved KYC and active savings account.
- 2 guarantor members with approved KYC and enough available FOSA/BOSA balance.
- 1 loan officer user.
- 1 loan product with `minGuarantors=2`, `guarantorCoverageRatio=1.0`, and active status.

Set shell variables:

```bash
API_BASE="https://YOUR-RENDER-SERVICE.onrender.com/api/v1"
TENANT_ID="tenant-uuid"
PRODUCT_ID="loan-product-uuid"
GUARANTOR_1_ID="guarantor-member-uuid-1"
GUARANTOR_2_ID="guarantor-member-uuid-2"
APPLICANT_TOKEN="applicant-jwt"
GUARANTOR_1_TOKEN="guarantor-1-jwt"
GUARANTOR_2_TOKEN="guarantor-2-jwt"
LOAN_OFFICER_TOKEN="loan-officer-jwt"
SUPER_ADMIN_TOKEN="super-admin-jwt"
```

## Step 1: Applicant applies

```bash
curl -i -X POST "$API_BASE/members/loans/apply" \
  -H "Authorization: Bearer $APPLICANT_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "X-Idempotency-Key: apply-$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{
    "loanProductId": "'"$PRODUCT_ID"'",
    "principalAmount": 50000,
    "tenureMonths": 12,
    "purpose": "School fees",
    "guarantors": [
      { "memberId": "'"$GUARANTOR_1_ID"'", "guaranteedAmount": 25000 },
      { "memberId": "'"$GUARANTOR_2_ID"'", "guaranteedAmount": 25000 }
    ]
  }'
```

Expected: `201 Created`, loan status `PENDING_GUARANTORS`. Save the returned loan id:

```bash
LOAN_ID="returned-loan-uuid"
```

## Step 2: Guarantor 1 accepts

```bash
curl -i -X POST "$API_BASE/members/loans/$LOAN_ID/guarantor-response" \
  -H "Authorization: Bearer $GUARANTOR_1_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "X-Idempotency-Key: g1-accept-$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{ "action": "ACCEPT" }'
```

Expected: `200 OK`, guarantor status `ACCEPTED`, loan status remains `PENDING_GUARANTORS`.

## Step 3: Guarantor 2 accepts

```bash
curl -i -X POST "$API_BASE/members/loans/$LOAN_ID/guarantor-response" \
  -H "Authorization: Bearer $GUARANTOR_2_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "X-Idempotency-Key: g2-accept-$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{ "action": "ACCEPT" }'
```

Expected: `200 OK`, second guarantor status `ACCEPTED`, loan status transitions to `PENDING_APPROVAL`.

## Step 4: Loan officer approves

```bash
curl -i -X PATCH "$API_BASE/admin/loans/$LOAN_ID/status" \
  -H "Authorization: Bearer $LOAN_OFFICER_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{ "status": "APPROVED" }'
```

Expected: `200 OK`, loan status `APPROVED`, applicant notification is queued asynchronously.

## Step 5: Super admin verifies audit trail

```bash
curl -i "$API_BASE/admin/audit-logs?page=1&limit=50&action=LOAN" \
  -H "Authorization: Bearer $SUPER_ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID"
```

Expected audit actions include:

- `LOAN.APPLY`
- `GUARANTOR.ACCEPTED` or `GUARANTOR.RESPOND`
- `LOAN.PENDING_APPROVAL`
- `LOAN.STATUS.APPROVED`

Verify metadata contains loan id, member/guarantor ids, status changes, IP address, and no passwords, OTPs, or tokens.

## Edge Case: IDOR attempt

Try to accept Guarantor 2's request using Guarantor 1's token:

```bash
curl -i -X POST "$API_BASE/members/loans/$LOAN_ID/guarantor-response" \
  -H "Authorization: Bearer $GUARANTOR_1_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "X-Idempotency-Key: idor-$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{ "action": "ACCEPT" }'
```

Expected: `403 Forbidden`. No guarantor status or loan status should change.
