# SMS Password Reset Testing

## 1. Environment Setup

Verify `backend/.env` contains the Africa's Talking credentials:

```bash
AFRICAS_TALKING_USERNAME=sandbox
AFRICAS_TALKING_API_KEY=your-api-key
AFRICAS_TALKING_SENDER_ID=your-sender-id
```

Verify Redis is running and reachable:

```bash
redis-cli PING
```

Verify the database is migrated and seeded with a tenant and member test account:

```bash
npm run prisma:deploy
npm run seed:clean-demo
```

## 2. Database Seeding

Use an existing valid tenant ID from your local database, then create or update a member user and profile for that tenant.

```sql
-- Replace tenant-id-here and member-id-here with valid IDs from your database.
INSERT INTO "User" (
  "id",
  "email",
  "phone",
  "phoneNumber",
  "passwordHash",
  "firstName",
  "lastName",
  "role",
  "tenantId",
  "isActive",
  "mustChangePassword",
  "createdAt",
  "updatedAt"
) VALUES (
  gen_random_uuid(),
  'sms-reset-member@example.com',
  '+254712345678',
  '254712345678',
  '$argon2id$v=19$m=65536,t=3,p=1$replaceWithExistingHash',
  'SMS',
  'Tester',
  'MEMBER',
  'tenant-id-here',
  true,
  false,
  now(),
  now()
);

INSERT INTO "Member" (
  "id",
  "userId",
  "tenantId",
  "memberNumber",
  "isActive",
  "createdAt",
  "updatedAt"
) VALUES (
  gen_random_uuid(),
  (SELECT "id" FROM "User" WHERE "email" = 'sms-reset-member@example.com'),
  'tenant-id-here',
  'MBR-SMS-001',
  true,
  now(),
  now()
);
```

If your local schema uses Prisma seed scripts, keep the same values above and run the project seed command instead.

## 3. API Testing With curl/Postman

Request an OTP:

```bash
curl -i -X POST http://localhost:3000/api/auth/password-reset/request \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: tenant-id-here" \
  -d '{"lastFiveDigits":"45678"}'
```

Expected response: HTTP `200` with a generic success message. This is intentional even when no user matches.

Check Bull Board for the SMS job:

```text
http://localhost:3000/admin/queues
```

Retrieve the OTP from Redis. First compute the key:

```bash
node -e "console.log('otp:pwd-reset:' + require('crypto').createHash('sha256').update('+254712345678').digest('hex'))"
redis-cli GET otp:pwd-reset:{hash}
```

Verify the OTP and set a new password:

```bash
curl -i -X POST http://localhost:3000/api/auth/password-reset/verify \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: tenant-id-here" \
  -d '{"lastFiveDigits":"45678","otp":"123456","newPassword":"NewSecure@2025!"}'
```

Expected response: HTTP `200` with `Password reset successfully. Please log in with your new password.`

## 4. Redis Verification

Compute the Redis key:

```bash
node -e "console.log('otp:pwd-reset:' + require('crypto').createHash('sha256').update('+254712345678').digest('hex'))"
```

Check whether the key exists:

```bash
redis-cli EXISTS otp:pwd-reset:{hash}
```

Check the TTL:

```bash
redis-cli TTL otp:pwd-reset:{hash}
```

Expected TTL after a fresh request is close to `1800` seconds.

Manually delete the OTP:

```bash
redis-cli DEL otp:pwd-reset:{hash}
```

## 5. BullMQ Verification

Open Bull Board:

```text
http://localhost:3000/admin/queues
```

Inspect `sms-queue` for pending, completed, and failed jobs. The job payload should contain:

```json
{
  "type": "PASSWORD_RESET_OTP",
  "phone": "+254712345678",
  "message": "Your Beba SACCO password reset code is ..."
}
```

## 6. SMS Delivery Verification

In sandbox mode, Africa's Talking simulates delivery and no real SMS is sent.

In live mode, verify the actual SMS is received on the phone and check the Africa's Talking dashboard for delivery status.

## 7. Edge Case Testing

Test wrong OTP:

```bash
curl -i -X POST http://localhost:3000/api/auth/password-reset/verify \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: tenant-id-here" \
  -d '{"lastFiveDigits":"45678","otp":"999999","newPassword":"NewSecure@2025!"}'
```

Expected response: HTTP `400`.

Test expired OTP by waiting 30 minutes or deleting the Redis key manually, then calling the verify endpoint. Expected response: HTTP `400`.

Test failed attempts by submitting the wrong OTP repeatedly. After three failed attempts, the OTP key should be deleted and a new code should be requested.

Test non-existent last five digits:

```bash
curl -i -X POST http://localhost:3000/api/auth/password-reset/request \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: tenant-id-here" \
  -d '{"lastFiveDigits":"99999"}'
```

Expected response: HTTP `200`.

Test throttling by sending four request calls within five minutes. The fourth request should return HTTP `429`.
