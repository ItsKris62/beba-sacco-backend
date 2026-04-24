# Beba SACCO Backend - NestJS 10 MVP

Production-ready, multi-tenant SACCO management backend for **KC Boda SACCO** in Kisumu, Kenya.

## 🏗️ Architecture

- **Framework**: NestJS 10 (TypeScript 5, strict mode)
- **Database**: PostgreSQL 15 (Neon) + Prisma 5
- **Cache/Queue**: Upstash Redis + BullMQ
- **Storage**: Cloudflare R2 (S3-compatible)
- **Analytics**: Tinybird (HTTP ingestion)
- **Monitoring**: Sentry (backend errors)
- **Deployment**: Render (Docker)

## 📁 Project Structure

```
backend/
├── src/
│   ├── common/              # Shared utilities
│   │   ├── config/          # App configuration
│   │   ├── decorators/      # Custom decorators (@Roles, @Public)
│   │   ├── guards/          # Auth guards (JWT, RBAC)
│   │   ├── interceptors/    # Tenant, Audit, Logging
│   │   ├── filters/         # Global exception filter
│   │   ├── middleware/      # Request ID
│   │   └── utils/           # Pagination, idempotency
│   ├── modules/
│   │   ├── auth/            # JWT authentication
│   │   ├── tenants/         # Multi-tenancy
│   │   ├── users/           # User management
│   │   ├── members/         # SACCO members
│   │   ├── accounts/        # BOSA/FOSA accounts
│   │   ├── loans/           # Loan products & applications
│   │   ├── mpesa/           # M-Pesa integration
│   │   ├── audit/           # Audit trail
│   │   ├── queue/           # BullMQ jobs
│   │   ├── storage/         # Cloudflare R2
│   │   ├── analytics/       # Tinybird
│   │   └── health/          # Health checks
│   ├── prisma/
│   │   ├── schema.prisma    # Database schema
│   │   └── prisma.service.ts
│   ├── main.ts              # Application bootstrap
│   └── app.module.ts        # Root module
├── test/                    # E2E tests
├── Dockerfile               # Production Docker image
└── package.json
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 15 (Neon recommended)
- Redis (Upstash recommended)

### Installation

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Edit .env with your credentials
nano .env

# Generate Prisma Client
npm run prisma:generate

# Run database migrations
npm run prisma:migrate

# Start development server
npm run start:dev
```

### Access Points

- **API**: http://localhost:3000/api
- **Swagger Docs**: http://localhost:3000/api/docs
- **Health Check**: http://localhost:3000/api/health

## 🔐 Security Features

✅ **Environment Validation** - Joi schema validation at startup  
✅ **Global Validation Pipe** - Whitelist, transform, forbid non-whitelisted  
✅ **Helmet** - Security headers  
✅ **CORS** - Configurable origin whitelist  
✅ **Rate Limiting** - 100 req/min per IP  
✅ **JWT Auth** - Access (15min) + Refresh (7 days) tokens  
✅ **RBAC** - Role-based access control  
✅ **Multi-Tenancy** - X-Tenant-ID header validation  
✅ **Audit Trail** - All actions logged  
✅ **Idempotency** - Duplicate request prevention (planned)

## 🎯 Phase 0: Complete ✅

**Status**: Scaffold complete, ready for Phase 1 implementation.

**Delivered**:

- ✅ Full NestJS project structure
- ✅ Prisma schema (public schema with Tenant, User, AuditLog)
- ✅ Global guards, interceptors, filters, middleware
- ✅ Swagger documentation setup
- ✅ Multi-tenant architecture (foundation)
- ✅ All module skeletons with TODO markers
- ✅ Docker production setup
- ✅ Environment validation
- ✅ Health check endpoints

---

# 📋 PHASE 1-5 IMPLEMENTATION ROADMAP

## 🔵 PHASE 1: Authentication & Multi-Tenancy (Week 1-2)

### Goals

- Implement full JWT authentication with refresh token rotation
- Complete multi-tenant middleware and database isolation
- Set up audit trail and analytics foundation

### Tasks

#### 1.1 Authentication Service

**File**: `src/modules/auth/auth.service.ts`

```typescript
// Implement methods:
- login(): Verify credentials, generate tokens, store refresh token hash
- register(): Hash password (bcrypt), create user, send verification email
- refreshToken(): Verify refresh token, rotate tokens, blacklist old token
- logout(): Blacklist refresh token in Redis
```

**Testing**:

```bash
# Manual test via Swagger
POST /api/auth/register
POST /api/auth/login
POST /api/auth/refresh
```

#### 1.2 JWT Strategy (Passport)

**File**: `src/modules/auth/strategies/jwt.strategy.ts` (CREATE)

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('app.jwt.secret'),
    });
  }

  async validate(payload: any) {
    // Find user by ID from JWT payload
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { tenant: true },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found or inactive');
    }

    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      tenantSchema: user.tenant.schemaName,
    };
  }
}
```

**Register in**: `src/modules/auth/auth.module.ts`

#### 1.3 Tenant Interceptor Implementation

**File**: `src/common/interceptors/tenant.interceptor.ts`

```typescript
// Implement:
1. Extract X-Tenant-ID from headers
2. Query Tenant table to get schemaName
3. Validate tenant is ACTIVE
4. Call prisma.setTenantContext(schemaName)
5. Attach tenant info to request object
```

#### 1.4 Database Migration - Public Schema

**Command**:

```bash
npx prisma migrate dev --name init_public_schema
```

**Verify**:

```sql
-- Check tables created
SELECT tablename FROM pg_tables WHERE schemaname = 'public';
```

#### 1.5 Seed Initial Data

**File**: `prisma/seed.ts` (CREATE)

```typescript
// Create:
- Super Admin user
- Default tenant (KC Boda SACCO)
- Test users (admin, manager, member)
```

**Run**:

```bash
npx prisma db seed
```

### Endpoints to Test

```bash
# 1. Register Super Admin
POST /api/auth/register
{
  "email": "admin@kcboda.co.ke",
  "password": "SecurePassword123!",
  "firstName": "Admin",
  "lastName": "User",
  "role": "SUPER_ADMIN",
  "tenantId": "{{TENANT_ID}}"
}

# 2. Login
POST /api/auth/login
{
  "email": "admin@kcboda.co.ke",
  "password": "SecurePassword123!"
}

# 3. Access Protected Route
GET /api/users
Headers:
  Authorization: Bearer {{ACCESS_TOKEN}}
  X-Tenant-ID: {{TENANT_ID}}

# 4. Refresh Token
POST /api/auth/refresh
{
  "refreshToken": "{{REFRESH_TOKEN}}"
}
```

### Acceptance Criteria

- ✅ User can register with strong password validation
- ✅ User can login and receive JWT tokens
- ✅ Access token expires after 15 minutes
- ✅ Refresh token rotates on use
- ✅ Protected routes require valid JWT
- ✅ X-Tenant-ID header is validated
- ✅ Tenant schema switching works
- ✅ Audit logs are created for auth events

---

## 🟢 PHASE 2: Members & User Management (Week 3-4)

### Goals

- Implement member onboarding
- Complete user CRUD operations
- Add tenant schema creation for business data

### Tasks

#### 2.1 Tenant Schema Creation

**File**: `src/modules/tenants/tenants.service.ts`

```typescript
async create(createTenantDto: CreateTenantDto) {
  // 1. Create tenant in public.Tenant
  const tenant = await this.prisma.tenant.create({
    data: {
      name: createTenantDto.name,
      slug: createTenantDto.slug,
      schemaName: `tenant_${createTenantDto.slug}`,
      contactEmail: createTenantDto.contactEmail,
      contactPhone: createTenantDto.contactPhone,
    },
  });

  // 2. Create tenant schema
  await this.prisma.$executeRawUnsafe(
    `CREATE SCHEMA IF NOT EXISTS "${tenant.schemaName}"`,
  );

  // 3. Run migrations in tenant schema
  // (Copy tables from template: Member, Account, Loan, etc.)

  // 4. Create admin user for tenant

  return tenant;
}
```

#### 2.2 Uncomment Prisma Models

**File**: `src/prisma/schema.prisma`

Uncomment and implement:

- Member
- Account (BOSA/FOSA)
- LoanProduct
- Loan
- GuarantorShip
- Transaction

**Migration**:

```bash
npx prisma migrate dev --name add_tenant_schemas
```

#### 2.3 Members Service Implementation

**File**: `src/modules/members/members.service.ts`

```typescript
// Implement:
- create(): Register new member with auto-generated member number
- findAll(): List members (tenant-scoped, paginated)
- findOne(): Get member details
- update(): Update member info
```

#### 2.4 File Upload Integration

**File**: `src/modules/storage/storage.service.ts`

```typescript
// Implement:
- getUploadUrl(): Generate R2 pre-signed URL for ID upload
- Frontend uploads directly to R2
- Backend stores file URL in database
```

### Endpoints to Test

```bash
# 1. Create Member
POST /api/members
Headers:
  Authorization: Bearer {{TOKEN}}
  X-Tenant-ID: {{TENANT_ID}}
Body:
{
  "userId": "{{USER_ID}}",
  "memberNumber": "MB001",
  "nationalId": "12345678",
  "employer": "Boda Boda Operators",
  "occupation": "Rider"
}

# 2. List Members
GET /api/members?page=1&limit=10

# 3. Get Upload URL
POST /api/storage/upload-url
{
  "filename": "id_front.jpg",
  "contentType": "image/jpeg"
}
```

### Acceptance Criteria

- ✅ Tenant schemas are created dynamically
- ✅ Members can be created with auto-generated member numbers
- ✅ Member data is isolated per tenant
- ✅ File uploads work via pre-signed URLs
- ✅ Member list is paginated

---

## 🟡 PHASE 3: Accounts & Loan Products (Week 5-6)

### Goals

- Implement BOSA/FOSA account creation
- Add loan product management
- Implement loan application workflow
- Add guarantorship system

### Tasks

#### 3.1 Account Service

**File**: `src/modules/accounts/accounts.service.ts`

```typescript
// Implement:
- create(): Create BOSA/FOSA account with auto-generated account number
- findAll(): List member accounts
- getBalance(): Calculate current balance
- getTransactionHistory(): Paginated transaction list
```

#### 3.2 Loan Products

**File**: `src/modules/loans/loans.service.ts`

```typescript
// Implement:
- createProduct(): Admin creates loan product
- findAllProducts(): List available loan products
- calculateLoanTerms(): Calculate monthly payment, total interest
```

#### 3.3 Loan Application Workflow

```typescript
// Implement:
1. applyForLoan(): Member submits application (status: DRAFT)
2. requestGuarantor(): Send guarantor requests
3. approveGuarantorship(): Guarantor accepts/rejects
4. approveLoan(): Admin approves (status: APPROVED)
5. disburseLoan(): Trigger M-Pesa B2C (Phase 4)
```

### Endpoints to Test

```bash
# 1. Create BOSA Account
POST /api/accounts
{
  "memberId": "{{MEMBER_ID}}",
  "accountType": "BOSA",
  "accountNumber": "BOSA-001"
}

# 2. Create Loan Product
POST /api/loans/products
{
  "name": "Emergency Loan",
  "code": "EMG001",
  "minAmount": 5000,
  "maxAmount": 50000,
  "interestRate": 10,
  "minTenureMonths": 1,
  "maxTenureMonths": 12,
  "requiresGuarantors": true,
  "minGuarantors": 2
}

# 3. Apply for Loan
POST /api/loans/apply
{
  "memberId": "{{MEMBER_ID}}",
  "loanProductId": "{{PRODUCT_ID}}",
  "principalAmount": 10000,
  "tenureMonths": 6
}

# 4. Request Guarantor
POST /api/loans/guarantors
{
  "loanId": "{{LOAN_ID}}",
  "guarantorId": "{{GUARANTOR_MEMBER_ID}}",
  "guaranteedAmount": 5000
}
```

### Acceptance Criteria

- ✅ BOSA/FOSA accounts can be created
- ✅ Loan products are configurable
- ✅ Loan calculator works correctly
- ✅ Guarantorship workflow is functional
- ✅ Loan status changes are audited

---

## 🔴 PHASE 4: M-Pesa Integration & Transactions (Week 7-8)

### Goals

- Integrate Safaricom Daraja API
- Implement STK Push for deposits/repayments
- Implement B2C for loan disbursements
- Add webhook callback handling
- Implement transaction processing

### Tasks

#### 4.1 M-Pesa Service

**File**: `src/modules/mpesa/mpesa.service.ts`

```typescript
// Implement:
- getAccessToken(): Fetch OAuth token (cache in Redis, TTL 1hr)
- stkPush(): Initiate Lipa Na M-Pesa
- b2cPayment(): Disburse loan to member
- queryTransactionStatus(): Check payment status
```

#### 4.2 Webhook Handlers

**File**: `src/modules/mpesa/mpesa-webhook.controller.ts`

```typescript
// Implement:
- stkCallback(): Process STK Push result
  1. Validate callback data
  2. Update Transaction status
  3. Update Account balance
  4. Send analytics event

- b2cCallback(): Process B2C result
  1. Validate callback
  2. Update Loan disbursement status
  3. Create Transaction record
```

#### 4.3 Transaction Service

**File**: `src/modules/transactions/transactions.service.ts` (CREATE)

```typescript
// Implement:
- create(): Record transaction
- updateBalance(): Atomic balance update with locks
- reconcile(): Match M-Pesa receipts with transactions
```

### Endpoints to Test

```bash
# 1. Initiate Deposit (STK Push)
POST /api/mpesa/stk-push
{
  "phoneNumber": "254712345678",
  "amount": 1000,
  "reference": "DEPOSIT-001",
  "accountReference": "BOSA-001"
}

# 2. Disburse Loan (B2C)
POST /api/loans/{{LOAN_ID}}/disburse
(Triggers B2C payment to member's phone)

# 3. Query Transaction Status
GET /api/mpesa/status/{{TRANSACTION_ID}}
```

### M-Pesa Sandbox Testing

```bash
# 1. Get credentials from https://developer.safaricom.co.ke
# 2. Use test credentials:
MPESA_CONSUMER_KEY=your_key
MPESA_CONSUMER_SECRET=your_secret
MPESA_ENVIRONMENT=sandbox

# 3. Test phone: 254708374149 (always successful)
# 4. Test phone: 254708374150 (always fails)
```

### Acceptance Criteria

- ✅ STK Push sends payment request to user
- ✅ Callback updates transaction status
- ✅ B2C disburses loan to phone number
- ✅ Balances update atomically (no race conditions)
- ✅ Failed transactions are retried (BullMQ)
- ✅ M-Pesa receipts are stored

---

## 🟣 PHASE 5: Analytics, Reports & Production Readiness (Week 9-10)

### Goals

- Complete Tinybird analytics integration
- Add report generation (PDF/Excel)
- Implement email notifications
- Production deployment to Render
- Performance optimization

### Tasks

#### 5.1 Tinybird Integration

**File**: `src/modules/analytics/analytics.service.ts`

```typescript
// Implement:
- sendEvent(): POST to Tinybird Events API
- sendBatch(): Bulk insert for performance
- createDashboards(): Setup Tinybird data sources and endpoints
```

**Data Sources**:

- `user_actions.datasource` (logins, actions)
- `api_requests.datasource` (performance monitoring)
- `transactions.datasource` (financial events)
- `errors.datasource` (error tracking)

#### 5.2 Report Generation

**File**: `src/modules/reports/reports.service.ts` (CREATE)

```typescript
// Implement:
- generateMemberStatement(): PDF statement
- generateLoanSchedule(): Repayment schedule
- exportTransactions(): Excel export
- generateDividendReport(): Annual dividends
```

**Libraries**:

- PDF: `pdfmake`
- Excel: `exceljs`

#### 5.3 Email Notifications

**File**: `src/modules/queue/processors/email.processor.ts`

```typescript
// Implement:
- Send welcome email on registration
- Send loan approval notification
- Send guarantor request notification
- Send payment confirmation
```

**Email Service**: Resend, SendGrid, or AWS SES

#### 5.4 Production Deployment

**Render Deployment**:

```bash
# 1. Create Render account
# 2. Create PostgreSQL (Neon)
# 3. Create Redis (Upstash)
# 4. Create Web Service (Docker)
# 5. Create Worker Service (BullMQ processor)
# 6. Set environment variables
# 7. Deploy
```

**Health Checks**:

```yaml
# render.yaml
services:
  - type: web
    name: beba-api
    env: docker
    healthCheckPath: /api/health
```

#### 5.5 Performance Optimization

```typescript
// Add:
- Database indexes (Prisma schema)
- Redis caching for frequently accessed data
- Connection pooling (Prisma)
- Query optimization (N+1 prevention)
- CDN for static assets (Cloudflare)
```

### Acceptance Criteria

- ✅ Analytics dashboard shows real-time metrics
- ✅ Reports generate correctly (PDF/Excel)
- ✅ Emails are sent reliably
- ✅ Application deployed to production
- ✅ Health checks pass
- ✅ Error tracking works (Sentry)
- ✅ Performance is acceptable (<200ms p95)

---

## 🔗 Frontend Integration Guide

### Headers Required

```typescript
// All authenticated requests must include:
const headers = {
  Authorization: `Bearer ${accessToken}`,
  'X-Tenant-ID': tenantId,
  'Content-Type': 'application/json',
};
```

### Authentication Flow

```typescript
// 1. Login
const loginResponse = await fetch('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email, password }),
});
const { accessToken, refreshToken, user } = await loginResponse.json();

// 2. Store tokens (localStorage or httpOnly cookies)
localStorage.setItem('accessToken', accessToken);
localStorage.setItem('refreshToken', refreshToken);
localStorage.setItem('tenantId', user.tenantId);

// 3. Refresh token when access token expires
const refreshResponse = await fetch('/api/auth/refresh', {
  method: 'POST',
  body: JSON.stringify({ refreshToken }),
});
const { accessToken: newAccessToken } = await refreshResponse.json();
```

### File Upload Flow (R2 Pre-signed URLs)

```typescript
// 1. Request upload URL
const urlResponse = await fetch('/api/storage/upload-url', {
  method: 'POST',
  headers,
  body: JSON.stringify({
    filename: 'id_front.jpg',
    contentType: 'image/jpeg',
  }),
});
const { uploadUrl, fileKey } = await urlResponse.json();

// 2. Upload directly to R2
await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'image/jpeg' },
  body: fileBlob,
});

// 3. Save file reference in backend
await fetch('/api/members/upload-document', {
  method: 'POST',
  headers,
  body: JSON.stringify({ fileKey, documentType: 'NATIONAL_ID' }),
});
```

### Error Handling

```typescript
// Standard error response format
interface ErrorResponse {
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path: string;
  requestId?: string;
}

// Handle errors
try {
  const response = await fetch('/api/members', { headers });
  if (!response.ok) {
    const error: ErrorResponse = await response.json();
    console.error(`Error: ${error.message}`);
  }
} catch (error) {
  console.error('Network error:', error);
}
```

---

## 📊 Database Schema Overview

### Public Schema (Global)

- **Tenant**: SACCO organizations
- **User**: Authentication & authorization
- **AuditLog**: Compliance trail

### Tenant Schemas (Isolated per SACCO)

- **Member**: SACCO member profiles
- **Account**: BOSA/FOSA accounts
- **Transaction**: Financial transactions
- **LoanProduct**: Loan product definitions
- **Loan**: Loan applications & repayments
- **GuarantorShip**: Loan guarantor relationships

---

## 🧪 Testing Commands

```bash
# Run unit tests
npm run test

# Run e2e tests
npm run test:e2e

# Run tests with coverage
npm run test:cov

# Run tests in watch mode
npm run test:watch
```

---

## 🚢 Deployment

### Environment Variables (Production)

```bash
# Required for production
NODE_ENV=production
DATABASE_URL=postgresql://...
JWT_SECRET=<generate-with-openssl-rand-base64-32>
JWT_REFRESH_SECRET=<generate-different-key>
REDIS_HOST=<upstash-redis-host>
REDIS_PASSWORD=<upstash-password>
R2_ACCESS_KEY_ID=<cloudflare-r2-key>
R2_SECRET_ACCESS_KEY=<cloudflare-r2-secret>
TINYBIRD_TOKEN=<tinybird-token>
SENTRY_DSN=<sentry-dsn>
MPESA_CONSUMER_KEY=<production-key>
MPESA_CONSUMER_SECRET=<production-secret>
MPESA_ENVIRONMENT=production
```

### Docker Build

```bash
# Build image
docker build -t beba-backend .

# Run container
docker run -p 3000:3000 --env-file .env beba-backend
```

### Render Deployment

1. Create `render.yaml`:

```yaml
services:
  - type: web
    name: beba-api
    env: docker
    dockerfilePath: ./Dockerfile
    healthCheckPath: /api/health
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        fromDatabase:
          name: beba-db
          property: connectionString
```

2. Push to GitHub
3. Connect Render to repository
4. Deploy

---

## 📚 Additional Resources

- **NestJS Docs**: https://docs.nestjs.com
- **Prisma Docs**: https://www.prisma.io/docs
- **Safaricom Daraja**: https://developer.safaricom.co.ke
- **Cloudflare R2**: https://developers.cloudflare.com/r2
- **Tinybird**: https://www.tinybird.co/docs

---

## 🤝 Contributing

1. Create feature branch: `git checkout -b feature/phase-1-auth`
2. Implement with tests
3. Run linting: `npm run lint`
4. Run tests: `npm run test`
5. Commit: `git commit -m "feat: implement JWT authentication"`
6. Push: `git push origin feature/phase-1-auth`
7. Create Pull Request

---

## 📄 License

UNLICENSED - Proprietary software for KC Boda SACCO

---

## ✅ Next Steps

**Ready for Phase 1 implementation!**

Reply with:

```
✅ Proceed to Phase 1: Authentication & Multi-Tenancy
```

And I'll provide the exact implementation code for:

- JWT authentication with refresh token rotation
- Multi-tenant middleware
- Database migrations
- Seed data
- E2E tests
