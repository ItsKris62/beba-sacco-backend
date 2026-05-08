# Beba SACCO — 10-Step Client Demo Script (Phase C)

## Prerequisites
- Demo tenant created with seeded data
- Admin user (MANAGER role) and member user ready
- Postman/Insomnia collection pre-loaded
- Dashboard, Loans, and Reports modules functional

---

## Step 1: Health Check & Tenant Context

| Field | Value |
|-------|-------|
| **Action** | `GET /api/health/ping` |
| **Headers** | `X-Tenant-ID: <tenant-uuid>` |
| **Expected Result** | `200 OK` — `{ "status": "ok" }` |
| **Rollback Trigger** | Any non-200 response → check Docker stack status |

---

## Step 2: Member Login & Token Refresh

| Field | Value |
|-------|-------|
| **Action** | `POST /api/auth/login` |
| **Headers** | `X-Tenant-ID: <tenant-uuid>` |
| **Body** | `{ "email": "member@demo.co.ke", "password": "DemoPass123!" }` |
| **Expected Result** | `200 OK` — accessToken + refreshToken returned. No password hash in response. |
| **Failure Branch** | `401` → "Invalid credentials" (no user enumeration) |
| **Rollback Trigger** | 500 error → check auth service logs |

**Token Refresh Test:**
```bash
curl -X POST $API/auth/refresh \
  -H "X-Tenant-ID: $TENANT" \
  -d '{"refreshToken": "<refresh-token>"}'
```
Expected: New accessToken returned.

---

## Step 3: Member Dashboard (Partial Fetch Fallback)

| Field | Value |
|-------|-------|
| **Action** | `GET /api/members/dashboard` |
| **Headers** | `Authorization: Bearer <token>`, `X-Tenant-ID: <tenant-uuid>` |
| **Expected Result** | `200 OK` — Full dashboard with balances, loans, transactions, guarantor requests. `partial: false` |
| **Failure Branch** | If DB connection fails → stale cache served with `partial: true` and warning array |
| **Rollback Trigger** | 500 or `partial: true` with 4 warnings → restart dashboard cache service |

---

## Step 4: Loan Application (Idempotent)

| Field | Value |
|-------|-------|
| **Action** | `POST /api/members/loans/apply` |
| **Headers** | `Authorization: Bearer <token>`, `X-Tenant-ID: <tenant-uuid>`, `X-Idempotency-Key: <uuid>` |
| **Body** | `{ "loanProductId": "...", "principalAmount": 50000, "tenureMonths": 6, "purpose": "Business expansion" }` |
| **Expected Result** | `201 Created` — loan created with `status: "DRAFT"` |
| **Failure Branch** | `409` → "Loan application is already being processed" (duplicate idempotency key) |
| **Rollback Trigger** | Validation error → check KYC status is APPROVED |

---

## Step 5: Admin Loan Review & Guarantor Invitation

| Field | Value |
|-------|-------|
| **Action** | `POST /api/admin/loans/:id/guarantors` |
| **Headers** | `Authorization: Bearer <admin-token>`, `X-Tenant-ID: <tenant-uuid>` |
| **Body** | `{ "guarantors": [{ "memberId": "...", "guaranteedAmount": 50000 }] }` |
| **Expected Result** | `200 OK` — Guarantors invited, loan status → `PENDING_GUARANTORS` |
| **Failure Branch** | `400` → Guarantor has insufficient FOSA balance |
| **Rollback Trigger** | 500 → check guarantor eligibility logic |

---

## Step 6: Guarantor Acceptance

| Field | Value |
|-------|-------|
| **Action** | `POST /api/members/loans/:id/guarantor-response` |
| **Headers** | `Authorization: Bearer <guarantor-token>`, `X-Tenant-ID: <tenant-uuid>` |
| **Body** | `{ "action": "ACCEPT", "notes": "I guarantee this loan" }` |
| **Expected Result** | `200 OK` — status → `ACCEPTED`. Loan auto-advances to `UNDER_REVIEW` when coverage ≥ 100% |
| **Failure Branch** | `400` → "You have already accepted this guarantee request" |
| **Rollback Trigger** | Loan doesn't advance → check coverage calculation |

---

## Step 7: Loan Disbursement (Idempotent & Serializable)

| Field | Value |
|-------|-------|
| **Action** | `PATCH /api/admin/loans/:id/review` |
| **Headers** | `Authorization: Bearer <admin-token>`, `X-Tenant-ID: <tenant-uuid>`, `Idempotency-Key: <uuid>` |
| **Body** | `{ "action": "DISBURSE", "comment": "Approved for disbursement" }` |
| **Expected Result** | `200 OK` — loan status → `ACTIVE`, FOSA balance credited, transaction record created |
| **Failure Branch** | `409` → "Loan already disbursed" (idempotent replay) |
| **Rollback Trigger** | `422` → Member has no active FOSA account or KYC not approved |

**Concurrency Test (k6):**
```bash
k6 run --env BASE_URL=$API --env TENANT_ID=$TENANT \
  --env ADMIN_TOKEN=$ADMIN_TOKEN --env LOAN_ID=$LOAN_ID \
  k6/disbursement-idempotency.js
```
Expected: Exactly 1 success, rest 409.

---

## Step 8: M-Pesa STK Deposit

| Field | Value |
|-------|-------|
| **Action** | `POST /api/members/deposit/mpesa` |
| **Headers** | `Authorization: Bearer <token>`, `X-Tenant-ID: <tenant-uuid>`, `X-Idempotency-Key: <uuid>` |
| **Body** | `{ "phone": "254712345678", "amount": 1000 }` |
| **Expected Result** | `202 Accepted` — checkoutRequestId returned for polling |
| **Failure Branch** | `429` → Rate limited (max 3 STK pushes per day per member) |
| **Rollback Trigger** | 500 → check M-Pesa Daraja API credentials |

**Polling:**
```bash
# Poll every 2s for up to 2 minutes
curl $API/members/deposit/status/$CHECKOUT_REQUEST_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT"
```
Expected transitions: `PENDING` → `SUCCESS` or `FAILED`

---

## Step 9: Report Generation (Async Queue)

| Field | Value |
|-------|-------|
| **Action** | `POST /api/admin/reports/generate` |
| **Headers** | `Authorization: Bearer <admin-token>`, `X-Tenant-ID: <tenant-uuid>`, `Idempotency-Key: <uuid>` |
| **Body** | `{ "reportType": "LOAN_BOOK", "format": "PDF", "fromDate": "2026-01-01", "toDate": "2026-12-31" }` |
| **Expected Result** | `202 Accepted` — jobId returned |
| **Failure Branch** | `403` → Member role cannot generate reports |
| **Rollback Trigger** | 500 → check BullMQ worker health |

**Polling:**
```bash
# Poll status
curl $API/admin/reports/$JOB_ID/status \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT"
```
Expected: `QUEUED` → `RUNNING` → `SUCCEEDED`

**Download:**
```bash
curl $API/admin/reports/$JOB_ID/download \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT"
```
Expected: `200 OK` with presigned URL and expiry timestamp.

---

## Step 10: Tenant Isolation Verification

| Field | Value |
|-------|-------|
| **Action** | Attempt cross-tenant data access |
| **Test 1** | Use Tenant A token with Tenant B `X-Tenant-ID` on any endpoint |
| **Expected** | `403 Forbidden` — "Token tenant does not match X-Tenant-ID" |
| **Test 2** | Access Tenant A resource (e.g., loan) using Tenant B context |
| **Expected** | `404 Not Found` — resource not found in this tenant |
| **Rollback Trigger** | `200 OK` with data → CRITICAL tenant isolation breach |

---

## Recording Checklist for Stakeholder Sign-Off

- [ ] All 10 steps executed successfully
- [ ] Idempotency verified (duplicate keys return 409)
- [ ] Concurrent disbursement test shows exactly 1 success
- [ ] M-Pesa deposit callback processed without double-credit
- [ ] Report async flow completes within 2 minutes
- [ ] Tenant isolation confirmed (no cross-tenant data leakage)
- [ ] PII redaction confirmed (no phone/ID numbers in logs)
- [ ] Audit trail shows immutable entries for all financial mutations
- [ ] Zero 500 errors during demo
- [ ] Client approves Phase C sign-off

---

## Postman Collection Structure Outline

```json
{
  "info": { "name": "Beba SACCO Phase C Demo", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/" },
  "item": [
    { "name": "1. Health Check", "request": { "method": "GET", "url": "{{base_url}}/api/health/ping" } },
    { "name": "2. Auth Login", "request": { "method": "POST", "url": "{{base_url}}/api/auth/login" } },
    { "name": "3. Member Dashboard", "request": { "method": "GET", "url": "{{base_url}}/api/members/dashboard" } },
    { "name": "4. Apply Loan", "request": { "method": "POST", "url": "{{base_url}}/api/members/loans/apply" } },
    { "name": "5. Invite Guarantors", "request": { "method": "POST", "url": "{{base_url}}/api/admin/loans/:id/guarantors" } },
    { "name": "6. Guarantor Response", "request": { "method": "POST", "url": "{{base_url}}/api/members/loans/:id/guarantor-response" } },
    { "name": "7. Disburse Loan", "request": { "method": "PATCH", "url": "{{base_url}}/api/admin/loans/:id/review" } },
    { "name": "8. M-Pesa Deposit", "request": { "method": "POST", "url": "{{base_url}}/api/members/deposit/mpesa" } },
    { "name": "9. Generate Report", "request": { "method": "POST", "url": "{{base_url}}/api/admin/reports/generate" } },
    { "name": "10. Tenant Isolation", "request": { "method": "GET", "url": "{{base_url}}/api/members/dashboard" } }
  ],
  "variable": [
    { "key": "base_url", "value": "http://localhost:3000" },
    { "key": "tenant_id", "value": "" },
    { "key": "access_token", "value": "" },
    { "key": "admin_token", "value": "" },
    { "key": "loan_id", "value": "" }
  ]
}
```
