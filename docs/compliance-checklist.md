# 🇰🇪 Beba SACCO — Kenya Regulatory Compliance Checklist
**Version:** 1.0.0-mvp  
**Date:** 2026-04-25  
**Prepared by:** Beba DevOps / Compliance Team  
**Regulatory Scope:** SASRA · ODPC (DPA 2019) · CBK Guidelines  

---

## HOW TO READ THIS DOCUMENT

| Symbol | Meaning |
|--------|---------|
| ✅ | Implemented & verified in codebase |
| ⚠️ | Partially implemented — remediation required before go-live |
| ❌ | Not implemented — blocking for production |
| 📋 | Operational / process control (not code) |

---

## PART A — SASRA (Sacco Societies Regulatory Authority)

> **Legal basis:** Sacco Societies Act Cap 490B; SASRA Prudential Guidelines 2020;  
> SASRA Circular No. 1/2021 (Digital Financial Services); SASRA Circular No. 3/2022 (Cybersecurity)

### A1. Loan Provisioning & Portfolio Quality

| # | Requirement | Status | Evidence / Notes |
|---|-------------|--------|-----------------|
| A1.1 | Loan staging: PERFORMING / WATCHLIST / NPL classification | ✅ | `LoanStaging` enum in schema; `arrearsDays` field on `Loan` model; daily accrual job updates staging |
| A1.2 | IFRS 9 ECL provisioning (PD × LGD × EAD) | ✅ | `ProvisioningEntry` model with `pd`, `lgd`, `ead`, `eclAmount` fields; `macroAdjustment` factor |
| A1.3 | NPL threshold: ≥ 90 days in arrears | ✅ | `LoanStaging.NPL` triggered at `arrearsDays >= 90` in accrual processor |
| A1.4 | Watchlist threshold: 30–89 days in arrears | ✅ | `LoanStaging.WATCHLIST` triggered at `arrearsDays >= 30` |
| A1.5 | Portfolio Quality Ratio (NPL/Total Loans) tracked | ✅ | `SasraRatioSnapshot.portfolioQualityRatio` stored monthly |
| A1.6 | Provisioning entries are immutable (no UPDATE/DELETE) | ✅ | `ProvisioningEntry` has no `updatedAt`; unique constraint on `(tenantId, loanId, calculationDate)` prevents overwrite |
| A1.7 | SASRA monthly ratio snapshot (liquidity, capital adequacy) | ✅ | `SasraRatioSnapshot` model; `CbkReturn` model for monthly filings |
| A1.8 | Single-borrower limit enforcement | ⚠️ | `ComplianceAlert` policy `CBK_SINGLE_BORROWER` exists; enforcement guard in loan approval not yet wired to hard-reject |

**Remediation A1.8:** Add `SingleBorrowerLimitGuard` in `loans.service.ts → approveLoan()` that checks `outstandingBalance / totalAssets < 0.25` (SASRA Prudential Guideline 4.3.1) and throws `ForbiddenException` if breached.

---

### A2. Interest Disclosure (CBK/SASRA Consumer Protection)

| # | Requirement | Status | Evidence / Notes |
|---|-------------|--------|-----------------|
| A2.1 | Interest rate disclosed at application time | ✅ | `Loan.interestRate` copied from `LoanProduct` at `applyLoan()` — immutable snapshot |
| A2.2 | Interest type (FLAT / REDUCING_BALANCE) disclosed | ✅ | `InterestType` enum; `LoanProduct.interestType` stored and copied to loan |
| A2.3 | Total Cost of Credit (TCC) calculated and disclosed | ⚠️ | Monthly instalment calculated; TCC = principal + total interest not surfaced in API response or member statement |
| A2.4 | Processing fee disclosed before disbursement | ✅ | `Loan.processingFee` stored; included in loan application response |
| A2.5 | Grace period terms disclosed | ✅ | `Loan.gracePeriodMonths` stored and returned in loan detail endpoint |
| A2.6 | Annual Percentage Rate (APR) disclosed | ❌ | APR not calculated or stored; CBK Consumer Protection Guidelines §8.2 requires APR disclosure |

**Remediation A2.3:** Add `totalCostOfCredit` field to `ApplyLoanDto` response: `TCC = (monthlyInstalment × tenureMonths) + processingFee`.  
**Remediation A2.6:** Implement `calculateApr()` utility in `loans.service.ts` using Newton-Raphson IRR method; store as `Loan.aprPercent Decimal(7,4)`.

---

### A3. Member Statement Format

| # | Requirement | Status | Evidence / Notes |
|---|-------------|--------|-----------------|
| A3.1 | Statement includes: date, description, debit, credit, running balance | ✅ | `Transaction` model has `balanceBefore`, `balanceAfter`, `description`, `createdAt` |
| A3.2 | Statement period clearly marked (from/to dates) | ✅ | `statements` module generates period-bounded statements |
| A3.3 | SACCO name, member number, account number on statement header | ✅ | `Tenant.name`, `Member.memberNumber`, `Account.accountNumber` included |
| A3.4 | Statement available in PDF format | ⚠️ | JSON/CSV export implemented; PDF generation not yet implemented |
| A3.5 | Statement accessible by member via self-service portal | ✅ | `/api/statements` endpoint; frontend `app/member/statements/page.tsx` |
| A3.6 | Loan repayment schedule available to member | ✅ | Loan detail endpoint returns `monthlyInstalment`, `tenureMonths`, `dueDate` |

**Remediation A3.4:** Integrate `@react-pdf/renderer` or `pdfkit` for PDF statement generation. Required for SASRA audit submissions.

---

### A4. Data Retention (SASRA Regulation 42)

| # | Requirement | Status | Evidence / Notes |
|---|-------------|--------|-----------------|
| A4.1 | Financial records retained minimum 7 years | ✅ | `DATA_RETENTION_YEARS=7` in `render.yaml`; `ComplianceService.runDataRetentionPurge()` enforces 7-year floor |
| A4.2 | Audit logs retained minimum 7 years | ✅ | `AuditLog` purge cutoff = `retentionYears` (default 7) in `runDataRetentionPurge()` |
| A4.3 | M-Pesa raw callback payloads never deleted | ✅ | `MpesaTransaction.callbackPayload` stored; schema comment: "Never delete this record" |
| A4.4 | Transaction records immutable (no UPDATE on completed) | ✅ | `Transaction.status` transitions enforced in service layer; no bulk-update paths |
| A4.5 | Automated retention enforcement job | ✅ | `audit-retention.processor.ts` BullMQ processor handles scheduled purge |

---

### A5. SASRA Audit Trail

| # | Requirement | Status | Evidence / Notes |
|---|-------------|--------|-----------------|
| A5.1 | All financial operations logged to `AuditLog` | ✅ | `AuditService.create()` called in all loan, transaction, and auth operations |
| A5.2 | Audit log is append-only (no UPDATE/DELETE in normal flow) | ✅ | No `auditLog.update()` calls in service layer; `deleteMany` only in 7-year purge |
| A5.3 | Cryptographic hash chain on audit log | ✅ | `AuditChainService.computeEntryHash()` uses SHA-256(tenantId+userId+action+resource+resourceId+timestamp+prevHash) |
| A5.4 | Hash chain verification endpoint | ✅ | `GET /admin/audit/verify-chain` via `AuditChainService.verifyChain()` |
| A5.5 | Trigger source recorded for all M-Pesa transactions | ✅ | `MpesaTriggerSource` enum (MEMBER/SYSTEM/OFFICER) on every `MpesaTransaction` |
| A5.6 | SASRA audit report (CSV export) | ✅ | `SasraValidatorService.exportAsCsv()` with UTF-8 BOM for Excel |
| A5.7 | Stale PENDING detection (>24h) | ✅ | `SasraValidatorService.detectStalePending()` with 24h threshold |
| A5.8 | Ledger cross-validation (M-Pesa ↔ Transaction amount) | ✅ | `SasraValidatorService.detectLedgerMismatches()` raw SQL cross-join |

---

## PART B — ODPC (Office of the Data Protection Commissioner)

> **Legal basis:** Kenya Data Protection Act 2019 (No. 24 of 2019);  
> Data Protection (General) Regulations 2021 (LN 46 of 2021);  
> Data Protection (Registration of Data Controllers and Processors) Regulations 2021

### B1. PII Minimization (DPA 2019 §25 — Data Minimisation Principle)

| # | Requirement | Status | Evidence / Notes |
|---|-------------|--------|-----------------|
| B1.1 | Only necessary PII collected (National ID, KRA PIN, phone) | ✅ | `Member` model collects: `nationalId`, `kraPin`, `employer`, `occupation`, `dateOfBirth` — all SACCO-required fields |
| B1.2 | Phone numbers masked in all logs | ✅ | `maskPhone()` utility used in `SasraValidatorService`; format: `254***1234` |
| B1.3 | Phone numbers masked in audit log metadata | ⚠️ | `maskPhone()` not consistently applied in `AuditService.create()` metadata payloads |
| B1.4 | National ID not logged in plaintext | ⚠️ | `nationalId` appears in SASRA CSV export (required by SASRA); must be access-controlled |
| B1.5 | PII fields excluded from error responses | ✅ | Global exception filter strips sensitive fields from 4xx/5xx responses |
| B1.6 | Sentry PII scrubbing configured | ⚠️ | `SENTRY_DSN` configured; `beforeSend` hook for PII scrubbing not verified in `main.ts` |

**Remediation B1.3:** Wrap all `metadata` objects passed to `AuditService.create()` through a `sanitizeMetadata()` helper that calls `maskPhone()` on any field matching `/phone|msisdn|mobile/i`.  
**Remediation B1.6:** Add `beforeSend` hook in Sentry init (see `monitoring-setup.ts` in Deliverable 2).

---

### B2. Consent Tracking (DPA 2019 §30 — Consent)

| # | Requirement | Status | Evidence / Notes |
|---|-------------|--------|-----------------|
| B2.1 | Explicit consent recorded before KYC data collection | ✅ | `DataConsent` model with `consentType`, `version`, `acceptedAt`, `ipAddress` |
| B2.2 | Consent recorded before data sharing with third parties | ✅ | `ComplianceService.assertExportConsent()` throws `ForbiddenException` if no consent |
| B2.3 | Consent withdrawal mechanism | ✅ | `ComplianceService.updateMemberConsent()` allows setting `consentDataSharing=false` |
| B2.4 | Consent audit trail (who accepted, when, from which IP) | ✅ | `ConsentService.acceptConsent()` writes `ODPC.CONSENT.ACCEPTED` audit entry with IP |
| B2.5 | Consent version tracking | ✅ | `DataConsent.version` field; unique constraint on `(userId, consentType, version)` |
| B2.6 | Consent required for `DATA_PROCESSING`, `STATEMENT_EXPORT`, `LOAN_TERMS` | ✅ | `ConsentAcceptDto.consentType` enum covers all three types |
| B2.7 | Consent check before CRB submission | ⚠️ | `CrbReport` submission does not verify `consentDataSharing` per member before including in report |

**Remediation B2.7:** In `CrbExportService`, filter out members where `consentDataSharing = false` before generating XML payload, or obtain explicit CRB-specific consent.

---

### B3. DSAR — Data Subject Access Request (DPA 2019 §26)

| # | Requirement | Status | Evidence / Notes |
|---|-------------|--------|-----------------|
| B3.1 | DSAR endpoint exists | ✅ | `DsarRequest` model; DSAR controller in compliance module |
| B3.2 | DSAR response within 30 days | ✅ | `DsarRequest.expiresAt` set to 30 days from creation; status tracked |
| B3.3 | DSAR includes all member data (transactions, loans, audit logs) | ✅ | `DsarRequest.auditTrail` JSON tracks included data categories |
| B3.4 | DSAR download via pre-signed URL (encrypted) | ✅ | `DsarRequest.downloadUrl` stores pre-signed R2/MinIO URL |
| B3.5 | DSAR auto-redaction after expiry | ✅ | `DsarRequest.redactedAt` field; `DsarRequestStatus.REDACTED` status |
| B3.6 | DSAR request logged in audit trail | ⚠️ | DSAR creation should write `ODPC.DSAR.REQUESTED` audit entry — verify in controller |
| B3.7 | DSAR accessible only by member or TENANT_ADMIN | ⚠️ | Role-based access control on DSAR endpoint needs explicit verification |

**Remediation B3.6:** Ensure `DsarController.createRequest()` calls `AuditService.create()` with action `ODPC.DSAR.REQUESTED`.  
**Remediation B3.7:** Add `@Roles(UserRole.MEMBER, UserRole.TENANT_ADMIN)` guard on DSAR endpoints.

---

### B4. Data Retention & Right to Erasure (DPA 2019 §§38–40)

| # | Requirement | Status | Evidence / Notes |
|---|-------------|--------|-----------------|
| B4.1 | Soft-delete for member records (not hard-delete) | ✅ | `Member.deletedAt` nullable field; `isActive=false` for deactivation |
| B4.2 | PII anonymization after 5-year inactivity | ✅ | `ComplianceService.runDataRetentionPurge()` sets `nationalId='[REDACTED]'` etc. |
| B4.3 | Financial records exempt from erasure (7-year SASRA requirement) | ✅ | `Transaction`, `Loan`, `AuditLog` records not deleted — only PII fields anonymized |
| B4.4 | Right to erasure request handling | ⚠️ | No dedicated erasure request endpoint; DSAR covers access but not erasure |

**Remediation B4.4:** Add `POST /compliance/erasure-request` endpoint that triggers `runDataRetentionPurge()` for a specific member, subject to SASRA 7-year financial record exemption.

---

### B5. Data Security (DPA 2019 §41 — Security of Personal Data)

| # | Requirement | Status | Evidence / Notes |
|---|-------------|--------|-----------------|
| B5.1 | Passwords hashed with Argon2id | ✅ | `argon2` library used in `auth.service.ts`; `passwordHash` field |
| B5.2 | Refresh tokens hashed (not stored plaintext) | ✅ | `User.refreshToken` stores Argon2 hash of refresh JWT |
| B5.3 | Database connection encrypted (TLS) | ✅ | Neon PostgreSQL enforces TLS; `DATABASE_URL` uses `sslmode=require` |
| B5.4 | Redis connection encrypted (TLS) | ✅ | `REDIS_TLS=true` in `render.yaml`; Upstash enforces TLS |
| B5.5 | File storage encrypted at rest | ✅ | Cloudflare R2 encrypts at rest by default (AES-256) |
| B5.6 | API rate limiting | ✅ | `@nestjs/throttler` configured; M-Pesa STK limited to 3/day per member |
| B5.7 | JWT expiry: access=15m, refresh=7d | ✅ | `JWT_ACCESS_EXPIRATION=15m`, `JWT_REFRESH_EXPIRATION=7d` in `render.yaml` |
| B5.8 | CORS restricted to known origins | ✅ | `CORS_ORIGIN` env var; not wildcard `*` |

---

## PART C — CBK (Central Bank of Kenya) Guidelines

> **Legal basis:** CBK Prudential Guidelines 2013 (revised 2019);  
> CBK Consumer Protection Guidelines 2013; CBK AML/CFT Guidelines 2020;  
> National Payment System Act 2011 (M-Pesa integration)

### C1. Audit Trail Immutability

| # | Requirement | Status | Evidence / Notes |
|---|-------------|--------|-----------------|
| C1.1 | Audit logs cannot be modified after creation | ✅ | No `auditLog.update()` in codebase; append-only pattern enforced |
| C1.2 | Cryptographic chain prevents retroactive tampering | ✅ | SHA-256 hash chain: `entryHash = SHA256(prevHash + fields)` |
| C1.3 | Chain verification available to auditors | ✅ | `GET /admin/audit/verify-chain` returns `{ valid, tamperEvidence[] }` |
| C1.4 | Audit log includes IP address and user agent | ✅ | `AuditLog.ipAddress`, `AuditLog.userAgent` fields |
| C1.5 | All admin actions logged | ✅ | `AuditInterceptor` applied globally; all controller actions produce audit entries |

---

### C2. Transaction Reconciliation

| # | Requirement | Status | Evidence / Notes |
|---|-------------|--------|-----------------|
| C2.1 | Daily reconciliation between M-Pesa and ledger | ✅ | `ReconciliationService` with daily settlement job |
| C2.2 | Reconciliation discrepancies flagged for review | ✅ | `TransactionStatus.RECON_PENDING` status; `ComplianceAlert` generated |
| C2.3 | Idempotency keys prevent double-posting | ✅ | `Transaction.reference @unique`; `MpesaTransaction.reference @unique` |
| C2.4 | M-Pesa callback idempotency (3-layer) | ✅ | Layer 1: BullMQ jobId dedup; Layer 2: status≠PENDING guard; Layer 3: `reference @unique` DB constraint |
| C2.5 | Reconciliation report accessible to auditors | ✅ | `GET /compliance/recon-report` endpoint |
| C2.6 | Balance before/after recorded on every transaction | ✅ | `Transaction.balanceBefore`, `Transaction.balanceAfter` — Decimal(18,4) |

---

### C3. Fraud Detection Hooks

| # | Requirement | Status | Evidence / Notes |
|---|-------------|--------|-----------------|
| C3.1 | Velocity checks on deposits/withdrawals | ✅ | `VelocityService` in `fraud` module; configurable thresholds |
| C3.2 | Device fingerprinting on login | ✅ | `DeviceFingerprintService`; `LoginSession` model with `ipHash`, `userAgent` |
| C3.3 | AML/CFT screening on KYC and large deposits | ✅ | `AmlScreening` model; `AmlScreeningStatus` enum (PENDING/CLEAR/FLAGGED/BLOCKED) |
| C3.4 | 4-eyes approval for large disbursements | ✅ | `LoanApprovalChain` model; `ApprovalChainService` enforces dual approval |
| C3.5 | Suspicious transaction alerts | ✅ | `ComplianceAlert` model with `CRITICAL` severity for fraud triggers |
| C3.6 | PEP/Sanctions watchlist screening | ✅ | `AmlScreening.watchlistMatches` JSON field stores matched entries |
| C3.7 | Fraud detection integrated with loan approval | ⚠️ | AML screening result not blocking loan disbursement if status=FLAGGED |

**Remediation C3.7:** In `loans.service.ts → disburseLoan()`, check `AmlScreening.status` for the member; block disbursement if `status = FLAGGED | BLOCKED`.

---

### C4. CRB Reporting (CBK/Credit Reference Bureau Regulations 2013)

| # | Requirement | Status | Evidence / Notes |
|---|-------------|--------|-----------------|
| C4.1 | CRB report model exists | ✅ | `CrbReport` model with `xmlPayload`, `status`, `submittedAt` |
| C4.2 | CRB submission via Integration Outbox (at-least-once) | ✅ | `IntegrationOutbox` with `idempotencyKey`; max 5 retry attempts |
| C4.3 | CRB report includes loan IDs and period | ✅ | `CrbReport.loanIds[]`, `periodStart`, `periodEnd` |
| C4.4 | CRB submission status tracked | ✅ | `CrbReportStatus` enum: PENDING/QUEUED/SUBMITTED/ACCEPTED/REJECTED/FAILED |
| C4.5 | Monthly CRB submission schedule | ⚠️ | Cron job for monthly CRB submission not verified as active in production |

**Remediation C4.5:** Verify `@Cron('0 2 1 * *')` (2 AM on 1st of month) is registered in the CRB processor and enabled in production.

---

### C5. M-Pesa / National Payment System Compliance

| # | Requirement | Status | Evidence / Notes |
|---|-------------|--------|-----------------|
| C5.1 | Safaricom IP allowlist enforced | ✅ | `MPESA_ALLOWED_IPS` in `render.yaml` with all 8 Safaricom production IPs |
| C5.2 | HMAC signature validation on callbacks | ✅ | `MPESA_WEBHOOK_SECRET` used for HMAC-SHA256 callback validation |
| C5.3 | Raw Daraja payload stored verbatim | ✅ | `MpesaTransaction.callbackPayload Json` — never modified |
| C5.4 | B2C disbursement security credential encrypted | ✅ | `MPESA_SECURITY_CREDENTIAL` is RSA-encrypted base64 (Safaricom public key) |
| C5.5 | STK push rate limit (3/day per member) | ✅ | `MPESA_STK_RATE_LIMIT_PER_DAY=3` enforced via Redis counter |
| C5.6 | M-Pesa environment set to production | ✅ | `MPESA_ENVIRONMENT=production` in `render.yaml` |

---

## PART D — Summary Scorecard

| Domain | Total Checks | ✅ Pass | ⚠️ Partial | ❌ Fail |
|--------|-------------|---------|-----------|--------|
| SASRA — Loan Provisioning | 8 | 7 | 1 | 0 |
| SASRA — Interest Disclosure | 6 | 4 | 1 | 1 |
| SASRA — Member Statements | 6 | 5 | 1 | 0 |
| SASRA — Data Retention | 5 | 5 | 0 | 0 |
| SASRA — Audit Trail | 8 | 8 | 0 | 0 |
| ODPC — PII Minimization | 6 | 4 | 2 | 0 |
| ODPC — Consent Tracking | 7 | 6 | 1 | 0 |
| ODPC — DSAR | 7 | 5 | 2 | 0 |
| ODPC — Data Retention | 4 | 3 | 1 | 0 |
| ODPC — Data Security | 8 | 8 | 0 | 0 |
| CBK — Audit Immutability | 5 | 5 | 0 | 0 |
| CBK — Reconciliation | 6 | 6 | 0 | 0 |
| CBK — Fraud Detection | 7 | 6 | 1 | 0 |
| CBK — CRB Reporting | 5 | 4 | 1 | 0 |
| CBK — M-Pesa / NPS | 6 | 6 | 0 | 0 |
| **TOTAL** | **94** | **82 (87%)** | **11 (12%)** | **1 (1%)** |

---

## PART E — Remediation Priority Matrix

| ID | Issue | Regulation | Priority | Effort | Owner |
|----|-------|-----------|----------|--------|-------|
| A2.6 | APR not calculated or disclosed | CBK Consumer Protection §8.2 | 🔴 HIGH | 2h | Backend |
| A1.8 | Single-borrower limit not hard-enforced | SASRA Prudential 4.3.1 | 🔴 HIGH | 1h | Backend |
| C3.7 | AML FLAGGED status not blocking disbursement | CBK AML/CFT Guidelines | 🔴 HIGH | 1h | Backend |
| A2.3 | Total Cost of Credit not in API response | CBK Consumer Protection §8.1 | 🟡 MEDIUM | 1h | Backend |
| B1.3 | Phone not masked in all audit metadata | ODPC DPA 2019 §25 | 🟡 MEDIUM | 2h | Backend |
| B2.7 | CRB submission ignores consent flag | ODPC DPA 2019 §30 | 🟡 MEDIUM | 2h | Backend |
| B3.6 | DSAR creation not audited | ODPC DPA 2019 §26 | 🟡 MEDIUM | 30m | Backend |
| B3.7 | DSAR RBAC not verified | ODPC DPA 2019 §26 | 🟡 MEDIUM | 30m | Backend |
| A3.4 | PDF statement not implemented | SASRA Audit Requirement | 🟡 MEDIUM | 4h | Backend |
| B4.4 | No erasure request endpoint | ODPC DPA 2019 §§38–40 | 🟡 MEDIUM | 2h | Backend |
| C4.5 | CRB monthly cron not verified | CBK CRB Regulations 2013 | 🟡 MEDIUM | 30m | DevOps |
| B1.6 | Sentry PII scrubbing not verified | ODPC DPA 2019 §41 | 🟡 MEDIUM | 1h | DevOps |

---

## PART F — Pre-Production Sign-off Criteria

The following items **MUST** be resolved before production go-live:

- [ ] **A2.6** — APR disclosure implemented (CBK hard requirement)
- [ ] **A1.8** — Single-borrower limit guard active in loan approval
- [ ] **C3.7** — AML FLAGGED blocks loan disbursement
- [ ] **B1.3** — Phone masking in all audit metadata
- [ ] **B2.7** — CRB consent check per member
- [ ] **B3.6 / B3.7** — DSAR audit + RBAC verified

The following items are **RECOMMENDED** before go-live but may be deferred to Sprint 3:

- [ ] A3.4 — PDF statement generation
- [ ] B4.4 — Erasure request endpoint
- [ ] C4.5 — CRB cron verification

---

*Generated by Beba SACCO Compliance Automation — Phase 5 Pre-Deployment Checklist*  
*Next review: 30 days post-launch or upon any regulatory circular update*

<!-- ✅ File complete — ready for review -->
