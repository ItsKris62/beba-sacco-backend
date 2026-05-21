# SACCO Member Document Upload and KYC QA/Security Validation

Date: 2026-05-20
Scope: NestJS backend, PostgreSQL/Prisma, S3-compatible MinIO/R2 pre-signed URLs, Redis/BullMQ, JWT auth, multi-tenant SACCO MVP.

## Executive Summary

Result: PARTIAL PASS / NOT MVP-HARDENED

The repository implements a functional KYC document upload and review flow, including member upload intents, direct storage PUT URLs, confirmation by object HEAD, tenant-scoped object keys, admin document review, KYC status updates, account provisioning, audit logging, and a KYC review BullMQ worker.

Several requested controls are missing or weaker than the test scope requires:

- Pre-signed upload TTL is 3600 seconds, not <= 15 minutes.
- No virus-scan queue or virus scan processor exists for documents.
- Checksum is accepted from the client and stored, but not independently computed or compared to object bytes.
- Pre-signed PUT URLs are not storage-level single-use; confirmation is status-gated but has a race window.
- Requested doc types `Passport Photo` and `Proof of Address` are not modeled; implemented required docs are `NATIONAL_ID_FRONT`, `NATIONAL_ID_BACK`, `KRA_PIN`, `MEMBER_FORM`.
- Requested member states `DRAFT -> SUBMITTED -> UNDER_REVIEW -> VERIFIED/REJECTED` do not exist; implemented statuses are `PENDING_UPLOAD`, `PENDING_REVIEW`, `APPROVED`, `REJECTED`.
- `MemberKYC` and `BullJobStatus` Prisma models are absent.
- PostgreSQL RLS exists for audit event tables in migration SQL, but not for `Document`, `Member`, or the main tenant tables.
- Swagger mostly documents 2xx paths for document endpoints, but lacks complete 4xx/5xx examples.
- Frontend has upload/status UI, but no byte-level progress bar, no explicit retry action, and the admin upload screen calls member upload APIs instead of the admin upload endpoint.

## Test Execution Notes

Command attempted:

```bash
npm run test:e2e -- --runInBand document.e2e-spec.ts
```

Outcome: INCONCLUSIVE. The focused e2e test run timed out after 184 seconds and was killed. Jest does discover the test file:

```bash
npm run test:e2e -- --listTests document.e2e-spec.ts
# backend/test/document.e2e-spec.ts
```

Likely reason: e2e bootstrap depends on real Prisma database connectivity from environment. Redis is mocked in `test/helpers/test-app.factory.ts`, but Prisma is not mocked.

Static evidence was reviewed across:

- `backend/src/modules/documents/documents.service.ts`
- `backend/src/modules/members/member-portal.controller.ts`
- `backend/src/modules/documents/admin-documents.controller.ts`
- `backend/src/modules/kyc/kyc-review.processor.ts`
- `backend/src/prisma/schema.prisma`
- `beba-app-frontend/app/member/profile/page.tsx`
- `beba-app-frontend/app/admin/members/[id]/documents/page.tsx`
- `beba-app-frontend/hooks/use-document-upload.ts`

## Pass/Fail Matrix

| Area | Result | Evidence |
| --- | --- | --- |
| JWT plus `X-Tenant-ID` isolation | PASS | `TenantMiddleware` rejects mismatched JWT tenant/header tenant; member document service resolves member by `tenantId` plus `userId`. |
| Member owns upload/list/download | PASS | Member upload/list/download resolves member from authenticated `user.id`, not request member ID. |
| Staff role-scoped document viewing | PARTIAL | Service allows TENANT_ADMIN, MANAGER, CHAIRMAN, LOAN_OFFICER, AUDITOR; review only MANAGER/CHAIRMAN. Controller decorators are broad and depend on service checks. |
| Requested member creation in `DRAFT` | FAIL | No DRAFT KYC/member state. Member defaults to `PENDING_UPLOAD`. |
| Requested `/members/:id/documents/upload-url` | FAIL | Actual member route is `/members/documents/upload-url`; admin route is `/admin/kyc/documents/upload-url` with `memberId` in body. |
| Pre-signed URL generation | PASS | Upload intent creates `Document` row and returns `uploadUrl`, `objectKey`, `expiresIn`, `maxBytes`. |
| Expiration <= 15 minutes | FAIL | `UPLOAD_URL_TTL_SECONDS = 3600`. |
| Content type restriction | PASS | Document service allows jpeg/png/webp/pdf only. |
| Size limit <= 5 MB | PASS | DTO and confirmation enforce `MAX_DOCUMENT_UPLOAD_BYTES = 5 * 1024 * 1024`. |
| Single-use upload token | FAIL | No token table or one-time marker. URL can be reused until expiry; confirmation status prevents simple replay after success but not concurrent race. |
| Direct MinIO/S3 upload | PASS | S3-compatible pre-signed PUT via AWS SDK. |
| Checksum/hash verification | FAIL | `checksum` is stored from request; object bytes are not hashed server-side and compared. |
| Tenant/member/doc pathing | PASS | Object key format is `tenants/{tenantId}/members/{memberId}/{doc_type}_{timestamp}_{uuid}.{ext}`. |
| Failed upload retry | PARTIAL | User can request a new intent/version; no explicit retry token lifecycle. |
| Orphan cleanup | PARTIAL | Cron/processor marks expired `PENDING_UPLOAD` rows as `DELETED` and deletes storage object. Does not handle every orphan scenario. |
| Virus scan job | FAIL | No `virusScan` queue or processor found. |
| KYC validation job | PARTIAL | Async KYC review worker exists; no separate document validation pipeline. |
| Audit log job | PARTIAL | Audit persistence queues exist globally, but document service audit calls are synchronous fire-and-forget. |
| DLQ handling | PARTIAL | KYC review DLQ exists for exhausted job retries. No document scan DLQ. |
| Failed virus scan auto-reject | FAIL | No virus scan implementation. |
| Admin per-document approval/rejection | PASS | `/admin/kyc/documents/:id/review` sync and async review endpoints exist. Rejection reason required. |
| Member KYC approval/rejection | PASS | `/admin/members/:id/kyc` can approve/reject, requires notes on rejection, provisions FOSA/BOSA on approval. |
| Requested state transition names | FAIL | Implemented names differ: `PENDING_UPLOAD -> PENDING_REVIEW -> APPROVED/REJECTED`. |
| Notifications | PARTIAL | KYC worker enqueues email jobs; no webhook notification verified for KYC document decisions. |
| FOSA/BOSA activation only on full verification | PASS | Accounts are created only after all required docs are approved or admin KYC is approved. |
| Audit trail for upload/confirm/view/review | PARTIAL | Upload intent, confirm, download, and review emit audit records. "View list" is only globally audited via HTTP audit, not a domain-specific `DOCUMENT.VIEW`. |
| ODPC fields | PARTIAL | Audit logs include `ipAddress`/`userAgent`; consent exists in `DataConsent` and member consent fields. No `consent_timestamp` or `data_retention_policy` field names on `Document`/`AuditLog`. |
| Replacement/versioning | PASS | New upload intent increments document version; deletion is status `DELETED`, not hard delete. |
| Prisma checklist models | PARTIAL | `Document`, `AuditLog`, `KYCRequirement` exist. `MemberKYC` and `BullJobStatus` are absent. |
| Indexes | PASS | `Document` has indexes on tenant/member/status and tenant/member/type/status. |
| Swagger examples | PARTIAL | Many 2xx responses exist; document endpoints lack complete 4xx/5xx examples. |
| Frontend upload/review UX | PARTIAL | Upload form, status badges, admin review table exist. Missing upload progress percentage and explicit retry UI. Admin upload uses member API. |

## API Response Samples

Request member upload URL:

```bash
curl -X POST "$API/members/documents/upload-url" \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "NATIONAL_ID_FRONT",
    "originalFileName": "id-front.jpg",
    "mimeType": "image/jpeg",
    "sizeBytes": 1024,
    "checksum": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }'
```

Expected shape:

```json
{
  "documentId": "uuid",
  "uploadUrl": "https://storage.example/presigned-put",
  "preSignedUrl": "https://storage.example/presigned-put",
  "objectKey": "tenants/{tenantId}/members/{memberId}/national_id_front_...jpg",
  "expiresIn": 3600,
  "maxBytes": 5242880
}
```

Direct storage PUT:

```bash
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: image/jpeg" \
  --data-binary "@id-front.jpg"
```

Confirm member upload:

```bash
curl -X POST "$API/members/documents/$DOCUMENT_ID/confirm" \
  -H "Authorization: Bearer $MEMBER_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"checksum":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
```

Admin request upload URL on behalf of member:

```bash
curl -X POST "$API/admin/kyc/documents/upload-url" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "memberId": "member-uuid",
    "type": "KRA_PIN",
    "originalFileName": "kra.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 204800
  }'
```

Async document review:

```bash
curl -X POST "$API/admin/kyc/documents/$DOCUMENT_ID/review" \
  -H "Authorization: Bearer $MANAGER_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"status":"APPROVED"}'
```

Expected shape:

```json
{
  "status": "QUEUED",
  "jobId": "test-job-or-bullmq-id"
}
```

Reject document:

```bash
curl -X POST "$API/admin/kyc/documents/$DOCUMENT_ID/review" \
  -H "Authorization: Bearer $MANAGER_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"status":"REJECTED","rejectionReason":"Image is blurry; submit a clearer scan."}'
```

Approve full member KYC:

```bash
curl -X PATCH "$API/admin/members/$MEMBER_ID/kyc" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "verified": true,
    "documentIds": ["doc1","doc2","doc3","doc4"],
    "notes": "All mandatory KYC documents reviewed.",
    "checklist": {
      "idDocument": true,
      "kraPin": true,
      "memberFormSigned": true,
      "phoneVerified": true
    }
  }'
```

Reject full member KYC:

```bash
curl -X PATCH "$API/admin/members/$MEMBER_ID/kyc" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "verified": false,
    "notes": "Proof of identity could not be verified."
  }'
```

## Prisma Snapshot Queries

Use these to capture DB state after a live run:

```ts
await prisma.member.findUnique({
  where: { id: memberId },
  select: {
    id: true,
    tenantId: true,
    memberNumber: true,
    kycStatus: true,
    kycReviewedAt: true,
    kycReviewedByUserId: true,
    kycRejectionReason: true,
    consentDataSharing: true,
    consentUpdatedAt: true,
  },
});
```

```ts
await prisma.document.findMany({
  where: { tenantId, memberId },
  orderBy: [{ type: 'asc' }, { version: 'desc' }],
  select: {
    id: true,
    type: true,
    status: true,
    objectKey: true,
    mimeType: true,
    sizeBytes: true,
    checksum: true,
    version: true,
    expiresAt: true,
    reviewedById: true,
    reviewedAt: true,
    rejectionReason: true,
    createdAt: true,
  },
});
```

```ts
await prisma.account.findMany({
  where: { tenantId, memberId, accountType: { in: ['FOSA', 'BOSA'] } },
  select: {
    id: true,
    accountNumber: true,
    accountType: true,
    isActive: true,
    createdAt: true,
  },
});
```

```ts
await prisma.auditLog.findMany({
  where: {
    tenantId,
    OR: [
      { entityType: 'Document' },
      { entityType: 'Member', entityId: memberId },
    ],
  },
  orderBy: { timestamp: 'asc' },
  select: {
    action: true,
    entityType: true,
    entityId: true,
    ipAddress: true,
    userAgent: true,
    metadata: true,
    prevHash: true,
    entryHash: true,
    timestamp: true,
  },
});
```

## Redis/BullMQ Evidence Commands

Expected queues from code:

- `kyc.review`
- `kyc.review.dlq`
- `documents.cleanup`
- `email`
- `audit-persist`
- `audit-persist-dlq`

Inspect locally:

```bash
redis-cli -a "$REDIS_PASSWORD" KEYS "bull:*"
redis-cli -a "$REDIS_PASSWORD" LLEN "bull:kyc.review:wait"
redis-cli -a "$REDIS_PASSWORD" LLEN "bull:kyc.review:failed"
redis-cli -a "$REDIS_PASSWORD" LLEN "bull:kyc.review.dlq:wait"
redis-cli -a "$REDIS_PASSWORD" LLEN "bull:documents.cleanup:wait"
redis-cli -a "$REDIS_PASSWORD" LLEN "bull:email:wait"
```

Expected KYC review job payload:

```json
{
  "docId": "document-uuid",
  "reviewerId": "user-uuid",
  "action": "APPROVED",
  "tenantId": "tenant-uuid",
  "rejectionReason": null
}
```

## Security and Compliance Gaps

1. Reduce upload URL TTL to <= 900 seconds.
2. Add server-side checksum verification by streaming the object from storage and hashing it, or require and verify an immutable storage checksum/metadata header.
3. Add a real single-use upload token with atomic state transition, for example `PENDING_UPLOAD -> CONFIRMING -> PENDING_REVIEW`, using conditional update/count.
4. Add virus scanning: queue `document.virus-scan`, scan object after confirmation, move clean docs to `PENDING_REVIEW`, reject infected docs, and route exhausted failures to DLQ.
5. Add requested doc types or map them explicitly: `PASSPORT_PHOTO`, `PROOF_OF_ADDRESS`.
6. Align state names with business language or document the mapping: `PENDING_UPLOAD = DRAFT`, all required uploads present = `SUBMITTED`, `PENDING_REVIEW = UNDER_REVIEW`, `APPROVED = VERIFIED`.
7. Add `MemberKYC` and `BullJobStatus` only if the product requires separate normalized tracking; otherwise update the checklist to match current schema.
8. Add RLS policies for `Document`, `Member`, `Account`, and other tenant-scoped tables, not only audit event tables.
9. Add complete Swagger 400/401/403/404/409/413/415/500 examples for document endpoints.
10. Fix admin frontend upload to use `adminApi.requestDocUploadUrl` and `adminApi.confirmUpload` with target `memberId`.
11. Add frontend upload progress and retry controls around the direct storage PUT.
12. Add domain audit actions for document list/view operations if compliance requires explicit `DOCUMENT.VIEW`.
13. Add immutable protection at DB level for `AuditLog`, such as revoke update/delete from app role or triggers that block mutation.

## Recommended MVP Hardening Order

1. Fix upload security: TTL, checksum verification, single-use confirmation, concurrency-safe status transitions.
2. Add virus scan pipeline and DLQ visibility.
3. Align KYC document types and status vocabulary with the SACCO business workflow.
4. Fix admin frontend upload API usage and add progress/retry UI.
5. Add missing Swagger examples and focused e2e tests for negative cases.
6. Add database-level tenant enforcement/RLS and audit immutability controls.
