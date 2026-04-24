# Sprint 1 – Verification Protocol

Complete step-by-step commands to verify every flow.

---

## 0. Prerequisites

```bash
# Start all services
cd backend
docker-compose up -d postgres redis minio

# Install dependencies
npm install

# Set environment (copy and edit)
cp .env.example .env
```

---

## 1. DB Migration & Schema Verification

```bash
# Generate Prisma client (resolves all TS errors)
npm run prisma:generate

# Run migration (creates new Sprint 1 tables)
npm run prisma:migrate
# Enter migration name: sprint1_onboarding_locations_stages

# Verify tables exist
npx prisma studio --schema=src/prisma/schema.prisma
# OR via psql:
psql $DATABASE_URL -c "\dt public.*" | grep -E "county|constituency|ward|stage|member_application"
```

**Expected tables:**
- `County`, `Constituency`, `Ward`
- `Stage`, `StageAssignment`
- `MemberApplication`
- Updated `User` (idNumber, phoneNumber, wardId, userStatus columns)

---

## 2. Seed Execution

```bash
# Seed Nairobi + 11 Western Kenya counties + SUPER_ADMIN
npm run seed:locations

# Expected output:
# ✅ SUPER_ADMIN created: superadmin@beba.co.ke
# ✅ County: Bungoma (KE-039)
# ✅ County: Busia (KE-040)
# ✅ County: Homa Bay (KE-043)
# ✅ County: Kakamega (KE-037)
# ✅ County: Kisumu (KE-042)
# ✅ County: Migori (KE-044)
# ✅ County: Nairobi City (KE-047)
# ✅ County: Nandi (KE-029)
# ✅ County: Siaya (KE-041)
# ✅ County: Trans Nzoia (KE-026)
# ✅ County: Vihiga (KE-038)
# Counties: 11, Constituencies: 22+, Wards: 80+

# Verify county count
psql $DATABASE_URL -c "SELECT COUNT(*) FROM \"County\";"
# Expected: 11
```

---

## 3. Auth & Role Hierarchy

```bash
# Start backend
npm run start:dev

# 3a. Login as SUPER_ADMIN
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: <your-tenant-id>" \
  -d '{"email":"superadmin@beba.co.ke","password":"BebaAdmin@2026!"}' | jq .

# Save token
SUPER_TOKEN="<accessToken from response>"
TENANT_ID="<tenantId from response>"

# 3b. Create TENANT_ADMIN (SUPER_ADMIN can create any role)
curl -s -X POST http://localhost:3000/api/v1/admin/users \
  -H "Authorization: Bearer $SUPER_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@testsacco.co.ke",
    "firstName": "Test",
    "lastName": "Admin",
    "role": "TENANT_ADMIN",
    "phone": "0712000001"
  }' | jq .

# 3c. Login as TENANT_ADMIN
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -d '{"email":"admin@testsacco.co.ke","password":"<temp-password>"}' | jq .

ADMIN_TOKEN="<accessToken>"

# 3d. TENANT_ADMIN attempts to create SUPER_ADMIN → MUST FAIL with 403
curl -s -X POST http://localhost:3000/api/v1/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"email":"evil@hack.com","firstName":"Evil","lastName":"Hacker","role":"SUPER_ADMIN"}' | jq .
# Expected: {"statusCode":403,"message":"You cannot assign a role equal to or above your own"}
```

---

## 4. Location Endpoints (Redis-Cached)

```bash
# 4a. Get all counties (Nairobi + Western Kenya only)
curl -s http://localhost:3000/api/v1/locations/counties \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" | jq 'length'
# Expected: 11

# 4b. Get constituencies for Nairobi (KE-047)
NAIROBI_ID=$(curl -s http://localhost:3000/api/v1/locations/counties \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" | jq -r '.[] | select(.code=="KE-047") | .id')

curl -s "http://localhost:3000/api/v1/locations/constituencies?countyId=$NAIROBI_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" | jq '.[].name'
# Expected: Dagoretti North, Kibra, Langata, Westlands

# 4c. Get wards for Westlands
WESTLANDS_ID=$(curl -s "http://localhost:3000/api/v1/locations/constituencies?countyId=$NAIROBI_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" | jq -r '.[] | select(.name=="Westlands") | .id')

curl -s "http://localhost:3000/api/v1/locations/wards?constituencyId=$WESTLANDS_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" | jq '.[].name'
# Expected: Kangemi, Karura, Kitisuru, Mountain View, Parklands/Highridge

# 4d. Verify Redis cache hit (second call should be instant)
redis-cli keys "locations:*"
# Expected: locations:counties, locations:constituencies:*, locations:wards:*
```

---

## 5. Full Onboarding Flow

```bash
# Get a ward ID for testing
WARD_ID=$(curl -s "http://localhost:3000/api/v1/locations/wards?constituencyId=$WESTLANDS_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" | jq -r '.[0].id')

# 5a. Submit application
APP_RESPONSE=$(curl -s -X POST http://localhost:3000/api/v1/admin/applications \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"firstName\": \"James\",
    \"lastName\": \"Otieno\",
    \"idNumber\": \"12345678\",
    \"phoneNumber\": \"0712345678\",
    \"stageName\": \"Westlands Stage\",
    \"position\": \"MEMBER\",
    \"wardId\": \"$WARD_ID\"
  }")
echo $APP_RESPONSE | jq .
APP_ID=$(echo $APP_RESPONSE | jq -r '.id')

# Verify status = SUBMITTED
echo $APP_RESPONSE | jq '.status'
# Expected: "SUBMITTED"

# 5b. List pending queue
curl -s "http://localhost:3000/api/v1/admin/applications/pending" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" | jq '.meta'
# Expected: { total: 1, page: 1, ... }

# 5c. Approve application (atomic transaction)
APPROVE_RESPONSE=$(curl -s -X POST "http://localhost:3000/api/v1/admin/applications/$APP_ID/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"reviewNotes": "KYC verified in person"}')
echo $APPROVE_RESPONSE | jq .

# Verify all created atomically:
echo $APPROVE_RESPONSE | jq '{
  userId: .user.id,
  memberNumber: .member.memberNumber,
  accounts: [.accounts[].accountType],
  stage: .stage.name,
  position: .stageAssignment.position,
  tempPassword: .temporaryPassword
}'
# Expected:
# {
#   "userId": "<uuid>",
#   "memberNumber": "M-000001",
#   "accounts": ["FOSA", "BOSA"],
#   "stage": "Westlands Stage",
#   "position": "MEMBER",
#   "tempPassword": "<12-char password>"
# }

# 5d. Verify application status = APPROVED
curl -s "http://localhost:3000/api/v1/admin/applications/$APP_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" | jq '.status'
# Expected: "APPROVED"

# 5e. Verify DB records
psql $DATABASE_URL -c "
  SELECT u.email, u.\"idNumber\", m.\"memberNumber\", m.\"kycStatus\",
         COUNT(a.id) as accounts
  FROM \"User\" u
  JOIN \"Member\" m ON m.\"userId\" = u.id
  JOIN \"Account\" a ON a.\"memberId\" = m.id
  WHERE u.\"idNumber\" = '12345678'
  GROUP BY u.email, u.\"idNumber\", m.\"memberNumber\", m.\"kycStatus\";
"
# Expected: 1 row, accounts=2, kycStatus=APPROVED
```

---

## 6. Validation Tests (400 Bad Request)

```bash
# 6a. Invalid ID number (too short)
curl -s -X POST http://localhost:3000/api/v1/admin/applications \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d "{\"firstName\":\"Test\",\"lastName\":\"User\",\"idNumber\":\"123\",\"phoneNumber\":\"0712345679\",\"stageName\":\"Test Stage\",\"wardId\":\"$WARD_ID\"}" | jq '.message'
# Expected: ["idNumber must be a 7 or 8 digit Kenyan National ID number"]

# 6b. Invalid phone number
curl -s -X POST http://localhost:3000/api/v1/admin/applications \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d "{\"firstName\":\"Test\",\"lastName\":\"User\",\"idNumber\":\"87654321\",\"phoneNumber\":\"0812345678\",\"stageName\":\"Test Stage\",\"wardId\":\"$WARD_ID\"}" | jq '.message'
# Expected: ["phoneNumber must be a valid Kenyan phone number (07xxxxxxxxx or 2547xxxxxxxxx)"]

# 6c. Duplicate ID number (409 Conflict)
curl -s -X POST http://localhost:3000/api/v1/admin/applications \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d "{\"firstName\":\"Duplicate\",\"lastName\":\"User\",\"idNumber\":\"12345678\",\"phoneNumber\":\"0799999999\",\"stageName\":\"Test Stage\",\"wardId\":\"$WARD_ID\"}" | jq '{status: .statusCode, message: .message}'
# Expected: {"status": 409, "message": "An application with ID number 12345678 already exists..."}
```

---

## 7. Tenant Isolation

```bash
# Create a second tenant and user
TENANT_B_ID="<create via admin panel or seed>"

# Query members with Tenant B token → should return 0 results from Tenant A
curl -s "http://localhost:3000/api/v1/admin/applications/pending" \
  -H "Authorization: Bearer $TENANT_B_TOKEN" \
  -H "X-Tenant-ID: $TENANT_B_ID" | jq '.meta.total'
# Expected: 0 (Tenant A's applications are invisible)
```

---

## 8. Reject Flow

```bash
# Submit a new application
APP2_ID=$(curl -s -X POST http://localhost:3000/api/v1/admin/applications \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d "{\"firstName\":\"Jane\",\"lastName\":\"Wanjiku\",\"idNumber\":\"9876543\",\"phoneNumber\":\"0798765432\",\"stageName\":\"Kibra Stage\",\"wardId\":\"$WARD_ID\"}" | jq -r '.id')

# Reject it
curl -s -X POST "http://localhost:3000/api/v1/admin/applications/$APP2_ID/reject" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"reviewNotes": "ID document unclear, please resubmit with clearer scan"}' | jq .
# Expected: {"success": true, "message": "Application for Jane Wanjiku has been rejected."}

# Verify status
curl -s "http://localhost:3000/api/v1/admin/applications/$APP2_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" | jq '{status: .status, notes: .reviewNotes}'
# Expected: {"status": "REJECTED", "notes": "ID document unclear..."}
```

---

## 9. Stages

```bash
# Create a stage
curl -s -X POST http://localhost:3000/api/v1/admin/stages \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"Kangemi Stage\", \"wardId\": \"$WARD_ID\"}" | jq .

# List stages
curl -s http://localhost:3000/api/v1/admin/stages \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" | jq '.data[].name'
```

---

## 10. Frontend Checks

```bash
cd beba-app-frontend
npm run dev
# Open http://localhost:3001/admin/applications
```

**Manual checks:**
1. ✅ Location dropdowns show only Nairobi + Western Kenya counties (11 total)
2. ✅ Selecting a county loads constituencies; selecting constituency loads wards
3. ✅ Submitting form with invalid ID (e.g. "123") shows: "National ID must be 7 or 8 digits"
4. ✅ Submitting form with invalid phone (e.g. "0812345678") shows validation error
5. ✅ Application queue table shows paginated results with status badges
6. ✅ Clicking "Review" opens modal with KYC document link (if provided)
7. ✅ Approving updates table row to APPROVED status (optimistic update)
8. ✅ Rejecting requires a non-empty reason before confirming

---

## 11. Swagger UI

```
http://localhost:3000/api/docs
```

**Verify these tag groups exist:**
- `Applications (Onboarding)` – 5 endpoints
- `Locations` – 3 endpoints
- `Stages` – 4 endpoints

---

## 12. Audit Log Verification

```bash
# Check audit entries for the approval
psql $DATABASE_URL -c "
  SELECT action, resource, \"resourceId\", metadata->>'memberNumber' as member_number
  FROM \"AuditLog\"
  WHERE action IN ('APPLICATION.SUBMIT', 'APPLICATION.APPROVE', 'APPLICATION.REJECT')
  ORDER BY timestamp DESC
  LIMIT 10;
"
# Expected rows for each action performed above
```

---

## Summary of Sprint 1 Deliverables

| Deliverable | Status |
|---|---|
| Prisma schema (County, Constituency, Ward, Stage, StageAssignment, MemberApplication) | ✅ |
| User model extended (idNumber, phoneNumber, wardId, userStatus) | ✅ |
| LocationsModule (Redis-cached, 24h TTL) | ✅ |
| ApplicationsModule (submit, list, approve, reject) | ✅ |
| OnboardingService ($transaction: User+Member+FOSA+BOSA+Stage+Assignment) | ✅ |
| StagesModule (CRUD + position assignment) | ✅ |
| Seed script (11 counties, constituencies, wards + SUPER_ADMIN) | ✅ |
| Frontend: Applications queue page with form + review modal | ✅ |
| Frontend: LocationSelector cascading dropdowns | ✅ |
| Frontend: Zod validation (ID regex, phone regex) | ✅ |
| Swagger decorators on all endpoints | ✅ |
| Audit logging on all privileged actions | ✅ |
| Tenant isolation enforced | ✅ |
| Role hierarchy enforcement (no escalation) | ✅ |

**Deferred to Sprint 2:**
- Excel/CSV bulk import
- Email verification
- Self-service password reset
- Historical financial reconciliation
