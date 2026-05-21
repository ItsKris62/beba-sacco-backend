# Beba SACCO UAT Handoff Package

Version: 1.0  
Date: 2026-05-21  
Owner: Engineering

## What Is Included

- Hardened direct document upload with single-use tokens and server-side checksum verification.
- ODPC-aligned audit trail fields, retention metadata, and database-level audit immutability.
- Tenant isolation at the API layer, with feature-flagged PostgreSQL RLS for staged rollout.
- Business status labels for KYC workflows, including DRAFT, UNDER_REVIEW, VERIFIED, and REJECTED.
- Upload progress, retry, cancel, and quarantine handling in member and admin document screens.
- Correlation IDs across API responses, logs, and Sentry traces.

## Recommended Feature Flags For UAT

```bash
FEATURE_SECURE_UPLOAD_V2=true
FEATURE_KYC_STATUS_ALIAS=true
FEATURE_RLS_ENFORCEMENT=false
SENTRY_TRACES_SAMPLE_RATE=0.1
LOG_LEVEL=info
```

Enable `FEATURE_RLS_ENFORCEMENT=true` only after staging RLS checks pass with two test tenants.

## Member Portal Flows

1. Create or log in as a UAT member.
2. Upload `NATIONAL_ID_FRONT`, `NATIONAL_ID_BACK`, `KRA_PIN`, and `MEMBER_FORM`.
3. Confirm the UI shows upload progress and then an under-review status.
4. Cancel one upload mid-flight and confirm the UI resets.
5. Retry an interrupted upload and confirm it completes without a duplicate document decision.
6. Apply for a loan only after KYC is shown as VERIFIED.

## Admin Portal Flows

1. Open a member record and upload a document on behalf of the member.
2. Confirm the admin upload uses the KYC document endpoint and refreshes the document list.
3. Approve and reject individual documents with reviewer notes.
4. Approve full member KYC using VERIFIED/status alias behavior.
5. Confirm missing FOSA/BOSA accounts are created after KYC approval.
6. Confirm a tenant A admin cannot view tenant B records.

## Security And Compliance Checks

1. Reuse a secure upload token after successful confirmation. Expected result: `409 INVALID_UPLOAD_TOKEN`.
2. Upload a file whose bytes do not match the checksum. Expected result: document status becomes `QUARANTINE`.
3. Query audit logs for document upload, confirmation, review, and KYC update events.
4. Attempt direct audit log update/delete in staging. Expected result: `AUDIT_IMMUTABLE`.
5. Check API error responses for `correlationId` and use that ID to find the matching Render/Sentry logs.

## Pre-UAT Automation

```bash
cd backend
API_BASE=https://beba-sacco-api-staging.onrender.com/api \
TENANT_ID=<tenant-uuid> \
MEMBER_TOKEN=<member-jwt> \
ADMIN_TOKEN=<admin-jwt> \
FEATURE_SECURE_UPLOAD_V2=true \
FEATURE_KYC_STATUS_ALIAS=true \
./scripts/pre-uat-validation.sh --environment staging --tenant <tenant-uuid>
```

Automated smoke test:

```bash
npm run test:e2e -- pre-uat-smoke --runInBand
```

## Known Non-Blocking Limitations

- Virus scanning remains intentionally out of scope for this controlled deployment.
- Retention cleanup job is not included in Phase 3; `retention_until` is indexed for the follow-up job.
- RLS should be staged tenant-by-tenant before production enforcement.

## Rollback

1. Set `FEATURE_SECURE_UPLOAD_V2=false` to return to the legacy upload confirmation path.
2. Set `FEATURE_KYC_STATUS_ALIAS=false` if a frontend or reporting consumer requires internal status names.
3. Set `FEATURE_RLS_ENFORCEMENT=false` to rely on application-layer tenant filtering only.
4. Set `SENTRY_TRACES_SAMPLE_RATE=0` if tracing volume or latency becomes problematic.
5. Keep `LOG_LEVEL=info` unless debugging a live incident.

## UAT Sign-Off Checklist

- [ ] Member upload and retry flows validated.
- [ ] Admin upload and review flows validated.
- [ ] KYC approval provisions accounts correctly.
- [ ] Tenant isolation verified with two tenants.
- [ ] Audit log immutability verified in staging.
- [ ] Correlation IDs confirmed in error responses and logs.
- [ ] No P0/P1 issues remain open.
- [ ] Product and Compliance sign-off recorded.
