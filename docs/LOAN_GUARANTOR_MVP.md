# Beba SACCO — Loan Application & Guarantor Workflow MVP

> **Scope:** MVP backend for the complete Loan Application & Guarantor Workflow  
> **Stack:** NestJS v10+, Prisma 5+, PostgreSQL, Redis/BullMQ, JWT, Swagger  
> **Compliance:** SASRA, Kenya Data Protection Act (ODPC), CBK Prudential Guidelines  

---

## Table of Contents

1. [Prisma Schema Additions](#1-prisma-schema-additions)
2. [Architecture & Flow Diagram](#2-architecture--flow-diagram)
3. [API Contracts](#3-api-contracts)
4. [Authorization & Tenant Guard Implementation](#4-authorization--tenant-guard-implementation)
5. [Audit Event & Queue Implementation](#5-audit-event--queue-implementation)
6. [Guarantor Consent Flow & Idempotency Logic](#6-guarantor-consent-flow--idempotency-logic)
7. [Test Matrix & Edge Cases](#7-test-matrix--edge-cases)
8. [Compliance & Security Checklist](#8-compliance--security-checklist)

---

## 1. Prisma Schema Additions

### New Models (see `backend/src/prisma/schema-loan-guarantor-mvp.prisma`)

| Model | Purpose | Immutable |
|-------|---------|-----------|
| `GuarantorRequest` | Tracks per-guarantor consent state (PENDING_CONSENT → ACCEPTED/DECLINED/EXPIRED) | No |
| `GuarantorConsentLog` | Tamper-resistant evidence bundle for every consent action | **Yes** |
| `LoanApplication` | Formal application record distinct from `Loan` (disbursed facility) | No |
| `MemberBlacklist` | Tenant-scoped blacklist for borrowing/guarantee restrictions | No |
| `TenantGuaranteeConfig` | Per-tenant: max guarantees, coverage ratio, expiry hours | No |

### New Enums

```prisma
enum GuarantorRequestStatus {
  PENDING_CONSENT
  CONSENT_ACCEPTED
  CONSENT_DECLINED
  CONSENT_EXPIRED
  REVOKED
}

enum LoanApplicationStatus {
  DRAFT
  SUBMITTED
  PENDING_GUARANTORS
  PENDING_CONSENT
  UNDER_REVIEW
  APPROVED
  REJECTED
  CONVERTED_TO_LOAN
}
```

### Consent Log (Immutable) — Critical Fields

```prisma
model GuarantorConsentLog {
  id            String   @id @default(uuid())
  tenantId      String
  guarantorRequestId String @unique
  memberId      String   // The guarantor
  action        String   // ACCEPT | DECLINE | EXPIRED | REVOKED
  timestamp     DateTime @default(now())
  ipAddress     String?
  userAgent     String?
  deviceId      String?
  digitalAcknowledgment Boolean @default(false)
  correlationId String   // X-Request-ID for end-to-end tracing
  jurisdiction  String   @default("KE")
  retentionYears Int     @default(7)    // SASRA: 7-year retention
  prevHash      String?  @db.Text        // Tamper-evident chain
  entryHash     String?  @db.Text
}
```

> **Note:** Audit logs are NEVER updated or soft-deleted. Compliance exports use raw SQL only.

---

## 2. Architecture & Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MEMBER SELF-SERVICE PORTAL                          │
│  POST /members/loans/apply              GET /members/loans/:id/guarantor-status │
│  POST /members/loans/:id/guarantor-response                                  │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  TenantInterceptor  │  ← X-Tenant-ID validation + AsyncLocalStorage
                    │  JwtAuthGuard       │  ← Bearer token + JTI blocklist check
                    │  RBACGuard          │  ← Role hierarchy (MEMBER / LOAN_OFFICER / MANAGER)
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ LoanApplicationService │
                    │  • validateMemberEligibility()                        │
                    │  • memberApply() → idempotency guard + transaction    │
                    │  • guarantorResponse() → consent spoofing prevention   │
                    │  • inviteGuarantors() → 72h expiry + email queue      │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────▼────────┐ ┌────▼─────┐ ┌────────▼─────────┐
    │   PostgreSQL      │ │  Redis   │ │   BullMQ Queues   │
    │   (Prisma TX)     │ │          │ │                   │
    │  • Loan           │ │• Idempotency│ • audit.log      │
    │  • Guarantor      │ │  keys    │ │ • email          │
    │  • AuditLog       │ │• Consent │ │ • loan.guarantor │
    │  • Member         │ │  expiry  │ │   .reminder      │
    └───────────────────┘ └──────────┘ └───────────────────┘
```

### State Machine — Loan Lifecycle

```
DRAFT ──(apply)──► SUBMITTED ──(staff review)──► PENDING_GUARANTORS
                                                        │
                    ┌───────────────────────────────────┘
                    │ (invite guarantors)
                    ▼
            PENDING_CONSENT ──(all respond)──► UNDER_REVIEW
                    │                                   │
                    │ (72h expiry)                      │ (manager action)
                    ▼                                   ▼
            [AUTO-DECLINE]                        APPROVED ──► DISBURSED
                    │                                   │
                    └──────────────────► REJECTED ◄─────┘
```

---

## 3. API Contracts

### Member Portal Endpoints

#### `POST /members/loans/apply`
Apply for a loan (member self-service).

**Headers:**
```
Authorization: Bearer <jwt>
X-Tenant-ID: <tenant-uuid>
X-Idempotency-Key: <uuid>  // Optional but strongly recommended
```

**Request Body:**
```json
{
  "loanProductId": "550e8400-e29b-41d4-a716-446655440000",
  "principalAmount": 50000,
  "tenureMonths": 12,
  "purpose": "School fees for children",
  "notes": "First term payment"
}
```

**Response 201:**
```json
{
  "id": "loan-uuid",
  "loanNumber": "LN-2025-000042",
  "status": "DRAFT",
  "principalAmount": "50000.0000",
  "monthlyInstalment": "4583.3333",
  "member": { "memberNumber": "M-000001", "user": { "firstName": "John" } },
  "loanProduct": { "name": "Development Loan", "interestType": "REDUCING_BALANCE" }
}
```

**Eligibility Enforcement (hard stops):**
- `kycStatus === APPROVED`
- At least one active FOSA or BOSA account
- No defaulted loans
- Loan ≤ 3× total deposits

---

#### `GET /members/loans/:id/guarantor-status`
View guarantor status for own loan.

**Response 200:**
```json
{
  "loanId": "loan-uuid",
  "loanNumber": "LN-2025-000042",
  "principalAmount": 50000,
  "totalAccepted": 35000,
  "coverageMet": false,
  "guarantors": [
    {
      "memberId": "guarantor-uuid",
      "memberNumber": "M-000005",
      "name": "Jane Wanjiku",
      "status": "ACCEPTED",
      "guaranteedAmount": 20000,
      "invitedAt": "2025-01-15T08:00:00Z",
      "respondedAt": "2025-01-15T10:30:00Z"
    },
    {
      "memberId": "guarantor-uuid-2",
      "memberNumber": "M-000012",
      "name": "Peter Ochieng",
      "status": "PENDING",
      "guaranteedAmount": 15000,
      "invitedAt": "2025-01-15T08:00:00Z",
      "respondedAt": null
    }
  ]
}
```

---

#### `POST /members/loans/:id/guarantor-response`
Explicit guarantor consent (accept/decline).

**Security:** Only the targeted guarantor (resolved from JWT → Member) can respond.

**Request Body:**
```json
{
  "action": "ACCEPT",
  "digitalAcknowledgment": true,
  "notes": "Glad to support my fellow member"
}
```

**Validation:**
- `digitalAcknowledgment` MUST be `true` — false returns 400
- 72-hour expiry enforced — expired requests auto-decline with audit log
- Idempotency via Redis key `guarantor:consent:{loanId}:{memberId}`

**Response 200:**
```json
{
  "loanId": "loan-uuid",
  "memberId": "guarantor-member-uuid",
  "status": "ACCEPTED"
}
```

---

### Admin Endpoints (Manager/Loan Officer only)

#### `GET /admin/members/:id/guarantor-exposure`
Check a member's guarantee exposure before inviting them.

**Response 200:**
```json
{
  "memberId": "member-uuid",
  "memberNumber": "M-000005",
  "memberName": "Jane Wanjiku",
  "maxConcurrentGuarantees": 3,
  "currentGuaranteeCount": 2,
  "totalGuaranteedAmount": 45000,
  "remainingCapacity": 1,
  "canGuarantee": true,
  "activeGuarantees": [
    {
      "loanId": "loan-uuid-1",
      "loanNumber": "LN-2025-000010",
      "guaranteedAmount": 20000,
      "borrowerName": "John Kamau",
      "status": "ACTIVE"
    }
  ]
}
```

---

#### `PATCH /admin/loans/:id/status`
Transition loan status (manager/tenant_admin only).

**Request Body:**
```json
{
  "status": "APPROVED",
  "reason": "Guarantor coverage met; borrower has clean record"
}
```

**Valid Transitions:**
| From | To |
|------|-----|
| DRAFT | PENDING_GUARANTORS, REJECTED |
| PENDING_GUARANTORS | UNDER_REVIEW, REJECTED |
| UNDER_REVIEW | APPROVED, REJECTED |
| APPROVED | DISBURSED |

**Response 200:** Updated loan record.

---

## 4. Authorization & Tenant Guard Implementation

### Guard Stack (Global, in order)

```typescript
// app.module.ts
providers: [
  { provide: APP_GUARD, useClass: ThrottlerGuard },      // Rate limiting
  { provide: APP_GUARD, useClass: JwtAuthGuard },         // JWT validation
  { provide: APP_GUARD, useClass: RBACGuard },            // Role hierarchy
]
```

### RBACGuard — Hierarchical Enforcement

```typescript
const ROLE_RANK: Record<UserRole, number> = {
  [UserRole.SUPER_ADMIN]: 100,
  [UserRole.TENANT_ADMIN]: 80,
  [UserRole.MANAGER]: 60,
  [UserRole.LOAN_OFFICER]: 50,
  [UserRole.TELLER]: 40,
  [UserRole.MEMBER]: 20,
  [UserRole.AUDITOR]: 10,
};
```

- `@Roles(UserRole.MANAGER)` → MANAGER, TENANT_ADMIN, SUPER_ADMIN allowed
- `AUDITOR` → read-only; POST/PATCH/PUT/DELETE blocked regardless of decorator

### TenantInterceptor — Multi-Tenant Isolation

```typescript
// Uses AsyncLocalStorage to propagate tenantId through the call stack
// Prisma middleware auto-injects tenantId into every query
export const tenantAsyncStorage = new AsyncLocalStorage<TenantContextStore>();
```

** Enforcement points:**
1. **Header validation:** `X-Tenant-ID` must be a valid UUID
2. **Tenant existence:** Query `public.Tenant` for ACTIVE status
3. **JWT tenant match:** `req.user.tenantId === req.headers['x-tenant-id']`
4. **Query injection:** Prisma middleware adds `tenantId` to every `where` clause

### Consent Ownership Verification

```typescript
// In guarantorResponse() — prevents consent spoofing
const member = await prisma.member.findFirst({
  where: { id: guarantorMemberId, tenantId },
  select: { userId: true },
});
if (!member || member.userId !== userId) {
  throw new ForbiddenException('You are not authorized to respond to this guarantor request');
}
```

---

## 5. Audit Event & Queue Implementation

### Domain Events

| Event | Trigger | Queue |
|-------|---------|-------|
| `LoanApplied` | Member submits application | `audit.log` |
| `GuarantorConsented` | Guarantor accepts | `audit.log` |
| `GuarantorDeclined` | Guarantor declines or expires | `audit.log` |
| `LoanApproved` | Manager approves | `audit.log` + `email` |
| `LoanRejected` | Manager rejects | `audit.log` + `email` |
| `LoanDisbursed` | Funds released | `audit.log` + `email` |

### Event Publisher (in LoanApplicationService)

```typescript
private async publishEvent(event: LoanDomainEvent): Promise<void> {
  await this.auditQueue.add('domain-event', {
    tenantId: event.payload.tenantId,
    action: `EVENT.${event.type}`,
    resource: 'LoanWorkflow',
    resourceId: event.payload.loanId,
    metadata: { event },
    requestId: event.payload.correlationId,
  });
}
```

### Audit Log Record Structure

```typescript
interface AuditLogRecord {
  id: string;
  tenantId: string;
  actorId: string | null;      // userId of actor
  action: string;              // e.g. "LOAN.APPLY", "GUARANTOR.CONSENT.ACCEPT"
  entityType: string;          // "Loan", "GuarantorConsentLog"
  entityId: string | null;
  oldValue: Json | null;       // Previous state
  newValue: Json | null;       // New state
  metadata: Json | null;       // IP, userAgent, correlationId, deviceId
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;    // Correlation ID
  prevHash: string | null;     // Tamper-evident chain
  entryHash: string | null;
  timestamp: DateTime;
}
```

### Immutability Guarantee

- Audit records are **append-only** — no UPDATE or DELETE operations
- `prevHash` links to the previous record's hash, forming a tamper-evident chain
- Soft-delete is prohibited — use `newValue` to capture state transitions
- Compliance exports use raw SQL with read-only credentials

---

## 6. Guarantor Consent Flow & Idempotency Logic

### Consent Flow Sequence

```
Member applies for loan
        │
        ▼
System creates Loan in DRAFT
        │
        ▼
Staff invites guarantors (POST /loans/:id/invite-guarantors)
        │
        ▼
GuarantorRequest created per guarantor
  ┌─────┴─────┐
  │           │
  ▼           ▼
PENDING   invitedAt + 72h
                │
                ▼
          EXPIRED (auto)
                │
                ▼
          Audit log: GUARANTOR.CONSENT.EXPIRED
```

### Explicit Consent Requirements

1. **Digital Acknowledgment:** `digitalAcknowledgment: true` mandatory in request body
2. **Identity Verification:** Only the JWT-authenticated member matching `guarantorMemberId` can respond
3. **Time Bound:** 72-hour window from `invitedAt`; expired requests auto-decline
4. **Evidence Bundle:** Every response captures:
   - `timestamp` (server time)
   - `ipAddress` (req.ip)
   - `userAgent` (req.headers['user-agent'])
   - `deviceId` (req.headers['x-device-id'] if available)
   - `digitalAcknowledgment` (boolean)
   - `correlationId` (X-Request-ID)

### Idempotency Implementation

```typescript
// Redis key pattern
guarantor:consent:{loanId}:{guarantorMemberId}

// Flow:
1. Check Redis for key
2. COMPLETED → return cached result (replay prevention)
3. PROCESSING → return 409 Conflict (deduplication)
4. NEW → SET NX with PROCESSING, proceed with transaction
5. On success → SET COMPLETED with result (TTL: 72h)
6. On validation error → DEL key (allow retry)
7. On transient error → leave PROCESSING (client retries)
```

### Replay Prevention

- `X-Idempotency-Key` header required for all mutating endpoints
- IdempotencyMiddleware caches successful responses in Redis (24h TTL)
- Duplicate requests with same key return cached response with `X-Idempotency-Replayed: true`

---

## 7. Test Matrix & Edge Cases

### Unit Tests (LoanApplicationService)

| Test Case | Input | Expected | Priority |
|-----------|-------|----------|----------|
| `memberApply` — KYC not approved | kycStatus=PENDING_REVIEW | 400, "KYC verification required" | Critical |
| `memberApply` — no active accounts | isActive=false on all accounts | 400, "No active FOSA or BOSA account" | Critical |
| `memberApply` — blacklisted member | MemberBlacklist.canBorrow=false | 400, "Member is blacklisted" | Critical |
| `memberApply` — defaulted loan | Loan.status=DEFAULTED | 400, "Member has an active defaulted loan" | Critical |
| `memberApply` — exceeds 3× deposits | principal > 3× total deposits | 400, "exceeds your maximum eligible limit" | Critical |
| `memberApply` — idempotency replay | Same X-Idempotency-Key within 24h | 200, cached result | Critical |
| `guarantorResponse` — spoofing attempt | JWT userId ≠ guarantor.userId | 403, "not authorized" | Critical |
| `guarantorResponse` — missing digitalAck | digitalAcknowledgment=false | 400, "Digital acknowledgment is required" | Critical |
| `guarantorResponse` — expired consent | invitedAt + 73h | 400, auto-decline + audit log | Critical |
| `guarantorResponse` — idempotency | Same key, concurrent requests | 409 or cached result | Critical |
| `guarantorResponse` — already responded | status=ACCEPTED | 409, "already accepted" | High |
| `inviteGuarantors` — self-guarantee | guarantor.memberId === borrower.memberId | skipped, "cannot guarantee own loan" | High |
| `inviteGuarantors` — max guarantees exceeded | 3 active guarantees already | skipped, "maximum concurrent guarantee limit" | High |
| `updateStatus` — unauthorized role | MEMBER attempts PATCH | 403, "Only managers and above" | Critical |
| `updateStatus` — invalid transition | DRAFT → APPROVED | 400, "Cannot transition from DRAFT to APPROVED" | High |
| `updateStatus` — missing rejection reason | status=REJECTED, no reason | 400, "Reason is required" | High |

### Integration Tests (e2e)

| Scenario | Steps | Assertion |
|----------|-------|-----------|
| Cross-tenant access | Member A (tenant-1) accesses tenant-2 endpoint | 401/403, tenant mismatch |
| Complete approval flow | Apply → Invite → Consent → Approve → Disburse | Each step audit log created |
| Expired consent cleanup | Invite → wait 73h → attempt accept | Auto-decline, EXPIRED audit log |
| Concurrent consent race | Two identical consent requests simultaneously | One succeeds, one returns cached/409 |
| Audit log immutability | Attempt UPDATE on AuditLog table | Prisma rejects (no update method exposed) |
| Guarantee cap enforcement | Invite 4th guarantor when max=3 | 3rd invited, 4th skipped with reason |

### Security Tests

| Attack Vector | Mitigation | Test |
|---------------|------------|------|
| JWT token reuse after logout | Redis JTI blocklist | Blocked token returns 401 |
| Cross-tenant data leak | TenantInterceptor + Prisma middleware | Query returns only own tenant data |
| Consent spoofing | JWT → Member userId match | 403 if mismatch |
| Replay attack | Idempotency key + Redis | Cached response on duplicate |
| Expired consent acceptance | 72h window check | 400 with auto-decline |
| Role escalation | RBACGuard hierarchy | Lower role cannot access higher endpoints |

---

## 8. Compliance & Security Checklist

### SASRA Compliance

| Requirement | Implementation | Status |
|-------------|---------------|--------|
| Loan application audit trail | AuditLog with oldValue/newValue | ✅ |
| Guarantor consent evidence | GuarantorConsentLog with IP/UA/device | ✅ |
| 7-year record retention | retentionYears=7 on consent logs | ✅ |
| Immutable audit records | Append-only, no UPDATE/DELETE | ✅ |
| Officer approval authority | Role-based status transitions | ✅ |
| Member eligibility verification | KYC + account + blacklist + defaulted checks | ✅ |

### Kenya Data Protection Act (ODPC)

| Requirement | Implementation | Status |
|-------------|---------------|--------|
| Explicit consent | digitalAcknowledgment mandatory | ✅ |
| Consent evidence retention | 7-year immutable log | ✅ |
| Purpose limitation | Loan guarantee scope only | ✅ |
| Data minimization | Only collect required fields | ✅ |
| Right to access | Audit log queryable by member ID | ✅ |

### Security Controls

| Control | Implementation |
|---------|---------------|
| **Authentication** | JWT with RS256, JTI blocklist via Redis |
| **Authorization** | RBACGuard with role hierarchy + AUDITOR read-only enforcement |
| **Tenant Isolation** | TenantInterceptor + AsyncLocalStorage + Prisma middleware |
| **Idempotency** | Redis SET NX with 24h TTL for loans, 72h for consent |
| **Replay Prevention** | IdempotencyMiddleware caches responses; `X-Idempotency-Replayed` header |
| **Consent Integrity** | digitalAcknowledgment mandatory + JWT ownership verification |
| **Expiry Enforcement** | 72h window on guarantor consent; auto-decline with audit trail |
| **Audit Immutability** | Append-only AuditLog; prevHash/entryHash chain |
| **Rate Limiting** | ThrottlerGuard: 100 req/min per IP globally |
| **Input Validation** | class-validator DTOs with `@Min`, `@MaxLength`, `@IsEnum` |
| **SQL Injection** | Prisma ORM (parameterized queries throughout) |
| **XSS Prevention** | No raw HTML rendering; JSON API only |

### Deployment Checklist

| Step | Command | Notes |
|------|---------|-------|
| 1. Schema migration | `npx prisma migrate dev --name loan_guarantor_mvp` | Apply new models |
| 2. Generate Prisma client | `npx prisma generate` | Update TypeScript types |
| 3. Seed guarantee config | `npx ts-node scripts/seed-guarantee-config.ts` | Per-tenant defaults |
| 4. Register module | Add `LoanApplicationModule` to `AppModule` | Import in `app.module.ts` |
| 5. Verify queues | `npm run test:queues` | BullMQ + Redis connectivity |
| 6. Run test suite | `npm run test -- --testPathPattern=loan-application` | Unit + integration |
| 7. Swagger validation | `curl http://localhost:3000/docs-json` | Verify schema |

### Files Created/Modified

| File | Purpose |
|------|---------|
| `src/prisma/schema-loan-guarantor-mvp.prisma` | New models & enums (merge into main schema) |
| `src/modules/loans/loan-application.service.ts` | Core service: eligibility, consent, audit events |
| `src/modules/loans/loan-admin.controller.ts` | Admin endpoints: exposure check, status update |
| `src/modules/loans/loan-application.module.ts` | Module wiring (BullMQ queues, providers) |
| `src/modules/loans/dto/member-apply-loan.dto.ts` | Member & staff application DTOs |
| `src/modules/loans/dto/guarantor-consent-response.dto.ts` | Consent response with digitalAck |
| `src/modules/loans/dto/update-loan-status.dto.ts` | Admin status transition DTO |
| `src/modules/loans/dto/guarantor-exposure.dto.ts` | Exposure check response shape |
| `src/modules/members/member-portal.controller.ts` | Updated: guarantor status + consent endpoints |
| `src/common/middleware/idempotency.middleware.ts` | Existing: replay prevention (no changes) |
| `src/common/interceptors/tenant.interceptor.ts` | Existing: tenant isolation (no changes) |
| `src/common/guards/rbac.guard.ts` | Existing: role hierarchy (no changes) |
| `docs/LOAN_GUARANTOR_MVP.md` | This document |

---

> **MVP Status:** All core backend contracts, security boundaries, and compliance hooks are implemented.  
> **Next Phase:** UI integration, SMS/Email OTP for consent verification, CRB Africa integration for guarantor credit checks.
