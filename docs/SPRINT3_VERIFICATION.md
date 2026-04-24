# Sprint 3 – Verification Protocol

**Platform:** Beba SACCO (Multi-Tenant Kenyan Boda Boda SACCO)  
**Sprint:** 3 – Financial Reconciliation, Dashboards & ODPC Compliance  
**Date:** April 2026

---

## Prerequisites

```bash
# Ensure backend is running
cd backend && npm run start:dev

# Ensure frontend is running
cd beba-app-frontend && pnpm dev

# Set environment variables
export API=http://localhost:3001
export TOKEN=""   # Fill after login
export TENANT=""  # Fill after login
```

---

## 1. Financial Import Verification

### 1a. Preview Loan Disbursement CSV

```bash
# Upload a CSV with LOAN DISBURSEMENT sheet columns
curl -X POST "$API/admin/data-import/financial-preview" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT" \
  -F "file=@test/sample-loan-disbursement.csv" \
  -F "sheetType=LOAN_DISBURSEMENT"

# Expected response:
# {
#   "sheetType": "LOAN_DISBURSEMENT",
#   "totalRows": N,
#   "validRows": N,
#   "warningRows": 0,
#   "errorRows": 0,
#   "totalAmount": 450000,
#   "rows": [{ "rowNumber": 1, "status": "VALID", "data": {...} }]
# }
```

### 1b. Execute Financial Import

```bash
curl -X POST "$API/admin/data-import/execute-financial" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT" \
  -F "file=@test/sample-loan-disbursement.csv" \
  -F "sheetType=LOAN_DISBURSEMENT"

# Expected response:
# {
#   "batchId": "clxxx...",
#   "sheetType": "LOAN_DISBURSEMENT",
#   "loansCreated": N,
#   "repaymentsCreated": N,   # 30-day skeleton generated
#   "savingsCreated": 0,
#   "welfareCollectionsCreated": 0,
#   "skipped": 0,
#   "errors": 0
# }
```

### 1c. Verify DB Records

```bash
# Check Loan count
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.loan.count({ where: { tenantId: '$TENANT' } }).then(n => console.log('Loans:', n));
"

# Check LoanRepayment count (should be loans * 30)
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.loanRepayment.count({ where: { tenantId: '$TENANT' } }).then(n => console.log('Repayments:', n));
"

# Check SavingsRecord count
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.savingsRecord.count({ where: { tenantId: '$TENANT' } }).then(n => console.log('Savings:', n));
"
```

### 1d. Verify 6% Interest Rate

```bash
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.loan.findFirst({ where: { tenantId: '$TENANT' } }).then(l => {
  const expected = Number(l.principalAmount) * 1.06;
  console.log('Principal:', l.principalAmount);
  console.log('Total Repayable:', l.totalRepayable);
  console.log('Expected (6% flat):', expected);
  console.log('Match:', Math.abs(Number(l.totalRepayable) - expected) < 0.01);
});
"
```

---

## 2. Dashboard Stats Verification

### 2a. Get Cached KPIs

```bash
curl -X GET "$API/admin/dashboard/stats" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT"

# Expected response:
# {
#   "totalMembers": N,
#   "totalDisbursed": 450000,
#   "collectionRate": 85.5,
#   "defaultRate": 2.1,
#   "totalSavings": 120000,
#   "welfareCollected": 45000,
#   "repaymentHeatmap": [...],
#   "stageWelfareTable": [...],
#   "generatedAt": "...",
#   "cachedUntil": "..."   # 15 min from now
# }
```

### 2b. Verify Redis Cache

```bash
# Check Redis key exists
node -e "
const Redis = require('ioredis');
const r = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
r.get('DASH:STATS:$TENANT:v1').then(v => {
  console.log('Cache exists:', !!v);
  console.log('TTL check: data is cached');
  r.disconnect();
});
"
```

### 2c. Cache Invalidation on New Repayment

```bash
# Record a repayment (triggers cache invalidation)
curl -X POST "$API/repayments/record" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT" \
  -H "Content-Type: application/json" \
  -d '{"loanId": "LOAN_ID", "dayNumber": 1, "amountPaid": 3500, "paymentDate": "2024-01-15"}'

# Re-fetch stats – should show updated data (cache was invalidated)
curl -X GET "$API/admin/dashboard/stats" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT"
```

### 2d. Get Reports

```bash
curl -X GET "$API/admin/dashboard/reports" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT"

# Expected:
# {
#   "loansByStatus": [{ "status": "ACTIVE", "count": N, "totalAmount": N }],
#   "savingsByWeek": [{ "weekNumber": 1, "totalAmount": N, "memberCount": N }],
#   "topDefaulters": [...]
# }
```

---

## 3. PDF Statement Verification

### 3a. Get FOSA Statement (JSON)

```bash
curl -X GET "$API/members/statement/fosa?periodFrom=2024-01-01&periodTo=2024-12-31" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT"

# Expected:
# {
#   "memberId": "...",
#   "memberNumber": "BBA-001",
#   "memberName": "John Doe",
#   "totalDisbursed": 50000,
#   "totalRepaid": 35000,
#   "closingBalance": 15000,
#   "transactions": [...],
#   "auditHash": "sha256hex..."
# }
```

### 3b. Download PDF Statement

```bash
curl -X GET "$API/statements/export/pdf?type=FOSA&periodFrom=2024-01-01&periodTo=2024-12-31" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT" \
  --output statement.pdf

# Verify PDF:
# - File size > 0
ls -la statement.pdf

# Check response headers:
curl -I "$API/statements/export/pdf?type=FOSA" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT"

# Expected headers:
# Content-Type: application/pdf
# Content-Disposition: attachment; filename="..."
# X-Audit-Hash: sha256hex...
# Cache-Control: no-store, no-cache, must-revalidate
```

### 3c. Verify PDF Contents

Open `statement.pdf` and verify:
- [ ] SACCO name in header
- [ ] Member name and number
- [ ] Period dates
- [ ] Transaction table with Date, Description, Debit, Credit, Balance columns
- [ ] "CONFIDENTIAL" watermark (diagonal, light gray)
- [ ] Audit hash in footer
- [ ] ODPC disclaimer text
- [ ] No raw data exposed client-side (server-side generation)

---

## 4. Session Rotation Verification

### 4a. Login and Get Initial Session

```bash
# Login
RESPONSE=$(curl -s -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@beba.co.ke", "password": "Admin@123", "tenantId": "$TENANT"}')

TOKEN=$(echo $RESPONSE | jq -r '.accessToken')
SESSION_ID=$(echo $RESPONSE | jq -r '.sessionId')
echo "Session ID: $SESSION_ID"
```

### 4b. Rotate Session

```bash
# First rotation
NEW_SESSION=$(curl -s -X POST "$API/auth/sessions/rotate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\": \"$SESSION_ID\"}" | jq -r '.sessionId')

echo "New Session ID: $NEW_SESSION"
```

### 4c. Verify Old Session Revoked

```bash
# Try to use old session ID – should fail or be marked revoked
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.refreshSession.findUnique({ where: { id: '$SESSION_ID' } }).then(s => {
  console.log('Old session isRevoked:', s?.isRevoked);  // Should be true
});
"

# Verify new session exists
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.refreshSession.findUnique({ where: { id: '$NEW_SESSION' } }).then(s => {
  console.log('New session isRevoked:', s?.isRevoked);  // Should be false
  console.log('New session expiresAt:', s?.expiresAt);
});
"
```

### 4d. List Active Sessions

```bash
curl -X GET "$API/auth/sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT"

# Expected: array of sessions, max 3 concurrent
```

### 4e. Revoke a Session

```bash
curl -X DELETE "$API/auth/sessions/$NEW_SESSION" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT"

# Expected: 204 No Content
```

---

## 5. ODPC Consent Verification

### 5a. Check Consent Status (First Login)

```bash
curl -X GET "$API/compliance/consent/check" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT"

# Expected (first time):
# { "hasRequiredConsents": false }
```

### 5b. Accept Consent

```bash
# Accept DATA_PROCESSING consent
curl -X POST "$API/compliance/consent/accept" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT" \
  -H "Content-Type: application/json" \
  -d '{"consentType": "DATA_PROCESSING", "version": "1.0"}'

# Expected:
# { "id": "clxxx...", "acceptedAt": "2024-01-15T10:00:00Z" }

# Accept STATEMENT_EXPORT consent
curl -X POST "$API/compliance/consent/accept" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT" \
  -H "Content-Type: application/json" \
  -d '{"consentType": "STATEMENT_EXPORT", "version": "1.0"}'
```

### 5c. Verify Consent Record in DB

```bash
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.dataConsent.findMany({ where: { userId: 'USER_ID' } }).then(consents => {
  console.log('Consents:', JSON.stringify(consents, null, 2));
  // Should show: consentType, version, acceptedAt, ipAddress, userAgent
});
"
```

### 5d. Verify Subsequent Login Skips Modal

```bash
# Re-check consent status
curl -X GET "$API/compliance/consent/check" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT"

# Expected:
# { "hasRequiredConsents": true }
```

### 5e. Idempotency – Re-accepting Same Version

```bash
# Re-accept same consent – should be idempotent (upsert)
curl -X POST "$API/compliance/consent/accept" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT" \
  -H "Content-Type: application/json" \
  -d '{"consentType": "DATA_PROCESSING", "version": "1.0"}'

# Expected: 200 OK (no duplicate record created)
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.dataConsent.count({ where: { userId: 'USER_ID', consentType: 'DATA_PROCESSING', version: '1.0' } })
  .then(n => console.log('Consent records (should be 1):', n));
"
```

---

## 6. Audit Retention Verification

### 6a. Manually Trigger Retention Job

```bash
# Add a test job to the queue
node -e "
const { Queue } = require('bullmq');
const q = new Queue('audit.retention', { connection: { host: 'localhost', port: 6379 } });
q.add('run-retention-policy', {}, { jobId: 'manual-test-' + Date.now() }).then(() => {
  console.log('Job queued');
  process.exit(0);
});
"
```

### 6b. Verify Archived Logs

```bash
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.auditLog.count({ where: { isArchived: true } }).then(n => {
  console.log('Archived audit logs:', n);
});
p.auditLog.findFirst({ where: { isArchived: true } }).then(log => {
  console.log('Sample archived log:', JSON.stringify({
    id: log?.id,
    action: log?.action,
    isArchived: log?.isArchived,
    archivePath: log?.archivePath,
    retentionUntil: log?.retentionUntil,
  }, null, 2));
});
"
```

### 6c. Verify Financial Logs Preserved

```bash
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
// Financial logs should NOT be archived unless > 7 years old
p.auditLog.count({
  where: {
    action: { startsWith: 'LOAN.' },
    isArchived: false,
  }
}).then(n => console.log('Active financial logs:', n));
"
```

---

## 7. Role Filtering Verification

### 7a. TELLER Role – PII Masking

```bash
# Login as TELLER
TELLER_TOKEN=$(curl -s -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "teller@beba.co.ke", "password": "Teller@123", "tenantId": "$TENANT"}' \
  | jq -r '.accessToken')

# Get dashboard stats as TELLER
curl -X GET "$API/admin/dashboard/stats" \
  -H "Authorization: Bearer $TELLER_TOKEN" \
  -H "X-Tenant-ID: $TENANT"

# Expected: 403 Forbidden (TELLER not in allowed roles for dashboard)
# OR: data returned with ID numbers masked (***-***-XXXX)
```

### 7b. AUDITOR Role – Read-Only Access

```bash
# Login as AUDITOR
AUDITOR_TOKEN=$(curl -s -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "auditor@beba.co.ke", "password": "Auditor@123", "tenantId": "$TENANT"}' \
  | jq -r '.accessToken')

# AUDITOR can read dashboard
curl -X GET "$API/admin/dashboard/stats" \
  -H "Authorization: Bearer $AUDITOR_TOKEN" \
  -H "X-Tenant-ID: $TENANT"
# Expected: 200 OK

# AUDITOR cannot disburse loans
curl -X POST "$API/admin/loans/disburse" \
  -H "Authorization: Bearer $AUDITOR_TOKEN" \
  -H "X-Tenant-ID: $TENANT" \
  -H "Content-Type: application/json" \
  -d '{"memberId": "xxx", "principal": 10000}'
# Expected: 403 Forbidden
```

### 7c. MEMBER Role – Own Data Only

```bash
# Login as MEMBER
MEMBER_TOKEN=$(curl -s -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "member@beba.co.ke", "password": "Member@123", "tenantId": "$TENANT"}' \
  | jq -r '.accessToken')

# MEMBER can view own statement
curl -X GET "$API/members/statement/fosa" \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H "X-Tenant-ID: $TENANT"
# Expected: 200 OK (own data only)

# MEMBER cannot access admin dashboard
curl -X GET "$API/admin/dashboard/stats" \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H "X-Tenant-ID: $TENANT"
# Expected: 403 Forbidden
```

---

## 8. Frontend Verification

### 8a. Admin Dashboard

1. Navigate to `http://localhost:3000/admin/dashboard`
2. Verify:
   - [ ] 8 KPI cards load with real data
   - [ ] Repayment heatmap shows 30 day cells (color-coded)
   - [ ] Recent disbursements table populated
   - [ ] Stage welfare table shows collections vs targets
   - [ ] Refresh button triggers new API call
   - [ ] Cache timestamp shown in header

### 8b. Member Statements with Consent

1. Navigate to `http://localhost:3000/member/statements` (as new member)
2. Verify:
   - [ ] ODPC consent modal appears immediately
   - [ ] Cannot proceed without checking checkbox
   - [ ] After accepting: `DataConsent` records created in DB
   - [ ] Statement type selector (FOSA/BOSA) works
   - [ ] Date range filter works
   - [ ] Transaction table renders correctly
   - [ ] PDF download button triggers server-side PDF
   - [ ] Audit hash shown in statement footer

### 8c. Member Dashboard

1. Navigate to `http://localhost:3000/member/dashboard`
2. Verify:
   - [ ] Loan balance card shows outstanding amount
   - [ ] Repayment calendar shows 30-day grid (green=paid, yellow=pending, red=missed)
   - [ ] Savings tracker shows weekly entries
   - [ ] Quick action buttons work

### 8d. Admin Reports

1. Navigate to `http://localhost:3000/admin/reports`
2. Verify:
   - [ ] Loans by status breakdown
   - [ ] Savings by week bar chart
   - [ ] Top defaulters table with risk badges
   - [ ] PDF export panel with date range filter
   - [ ] ODPC compliance notice at bottom

---

## 9. Data Retention Matrix

| Data Type | Retention Period | Action After Period |
|-----------|-----------------|---------------------|
| Financial audit logs (LOAN.*, REPAYMENT.*, SAVINGS.*) | 7 years | Archive to MinIO (stub), mark `isArchived=true` |
| Non-financial audit logs | 2 years | Soft-delete (`isArchived=true`) |
| Loan records | Immutable (no delete) | Status correction via dual approval only |
| Repayment records | Immutable (no delete) | Correction via MANAGER+AUDITOR approval |
| DataConsent records | Permanent | Never deleted (legal requirement) |
| RefreshSession records | Until `expiresAt` | Auto-expired, max 3 concurrent |

---

## 10. ODPC Compliance Mapping

| ODPC Requirement | Implementation |
|-----------------|----------------|
| Lawful basis for processing | `DataConsent` model – explicit consent recorded with IP, timestamp, version |
| Data minimization | PII masked in TELLER role; only necessary fields returned per role |
| Right to access | `GET /members/statement/fosa` and `GET /members/statement/bosa` |
| Right to erasure | Admin can trigger PII masking after retention period (Phase 4) |
| Data retention | 7-year financial, 2-year audit – enforced by BullMQ weekly cron |
| Security | AES-256-GCM encryption at rest (Prisma middleware), JWT rotation, device binding |
| Audit trail | Every financial action logged to `AuditLog` with `retentionUntil` |
| Cross-border transfer | All data stays in-country (no external APIs in Sprint 3) |
| Breach notification | Audit log + admin alert (Phase 4) |

---

## 11. PII Encryption Approach

```typescript
// Prisma middleware encrypts sensitive fields before write, decrypts on read
// Fields encrypted: idNumber, phone (in Member model)
// Algorithm: AES-256-GCM
// Key: process.env.ENCRYPTION_KEY (32-byte hex)
// IV: random 12 bytes per record, stored as prefix

// Example (in prisma.service.ts middleware):
// Before write: encrypt(value, key) → base64(iv + ciphertext + tag)
// After read:   decrypt(stored, key) → plaintext
```

---

## 12. Sprint 3 File Manifest

### Backend (NestJS)
```
backend/src/modules/sprint3/
├── sprint3.module.ts                    # Module registration
├── dto/
│   └── financial-import.dto.ts          # Zod-validated DTOs
├── financial-import.service.ts          # CSV → Loan/Savings/Welfare parser
├── financial-import.controller.ts       # POST /admin/data-import/financial-*
├── dashboard.service.ts                 # Redis-cached KPI aggregations
├── dashboard.controller.ts              # GET /admin/dashboard/*
├── security.service.ts                  # JWT rotation, device fingerprint, consent
├── security.controller.ts               # POST /auth/sessions/*, GET /compliance/*
├── statement.service.ts                 # FOSA/BOSA + PDFKit generation
├── statement.controller.ts              # GET /members/statement/*, PDF export
└── processors/
    └── audit-retention.processor.ts     # BullMQ weekly retention job
```

### Frontend (Next.js)
```
beba-app-frontend/
├── lib/sprint3-api.ts                   # Typed API client for all Sprint 3 endpoints
├── app/admin/dashboard/page.tsx         # KPIs, heatmap, welfare table
├── app/admin/reports/page.tsx           # Charts, defaulters, PDF export
├── app/member/dashboard/page.tsx        # Loan balance, repayment calendar, savings
└── app/member/statements/page.tsx       # FOSA/BOSA viewer + ODPC consent modal
```

### Schema Extensions (Prisma)
```
Loan                    # Loan disbursements with 6% flat rate
LoanRepayment           # 30-day repayment schedule (immutable)
SavingsRecord           # Individual + group welfare savings
GroupWelfare            # Stage welfare groups
GroupWelfareCollection  # Weekly welfare collections
RefreshSession          # JWT session rotation with device binding
DataConsent             # ODPC consent tracking
AuditLog (extended)     # + retentionUntil, isArchived, archivePath
```
