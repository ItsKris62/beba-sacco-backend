# PIN-Based Auth Flow — Frontend Integration Guide

This is the reference for the React/Next.js frontend team integrating the new
temporary-PIN onboarding and phone-based password reset flows. It replaces the
old "admin types a temporary password" model.

## Headers (every request)

| Header | Required on | Notes |
|---|---|---|
| `X-Tenant-ID` | All endpoints below | Tenant UUID. Validated by `TenantInterceptor`. |
| `Authorization: Bearer <accessToken>` | Only endpoints marked 🔒 below | Omit entirely for public endpoints — do not send an empty/stale token. |

Access tokens expire in **15 minutes**; refresh tokens in **7 days** (rotated on every
`POST /auth/refresh`, also delivered as an HttpOnly cookie — the response body copy
exists for backward compatibility and is flagged for removal via `migrateRefreshToken: true`).

---

## Flow 1 — Admin Creates a User (First Login)

1. Admin calls **`POST /users`** 🔒 (`TENANT_ADMIN` or `MANAGER`) with `email`, `firstName`,
   `lastName`, `phone` (now **required** — no `password` field anymore), and `role`.
2. Backend generates a 4-6 digit PIN server-side, SMS's it via Africa's Talking, and responds:
   ```json
   { "success": true, "message": "User created. PIN sent to phone.", "expiresAt": "2026-07-05T21:05:00.000Z", "user": { "id": "...", "email": "...", "...": "..." } }
   ```
   **The PIN is never in this response.**
3. Frontend shows a success toast/screen. Nothing else to do — the new user receives the PIN by SMS.
4. **If the SMS didn't arrive**, the admin has two recovery options, both scoped to `pinLoginRequired === true` users only (a 400 is returned otherwise):
   - **`POST /users/:id/resend-pin`** 🔒 (`TENANT_ADMIN`/`MANAGER`) — regenerates and re-sends via SMS, doesn't reveal the PIN to the admin. Use this by default.
   - **`POST /users/:id/reveal-pin`** 🔒 (`TENANT_ADMIN` only) — regenerates (always a *new* PIN — the old one is invalidated, the system never stores or re-displays a previously-sent PIN) and returns it in the response for the admin to read out/share directly: `{ "pin": "482913", "expiresAt": "..." }`. Every reveal is written to the audit log.
   - Both are rate-limited to **5 per hour per admin** (on top of a 5/min IP throttle) — Africa's Talking bills per SMS. Show the 429 message from the API as-is (see Error Handling below).

## Flow 2 — User First Login

1. User calls **`POST /auth/verify-pin`** (public) with `{ "phone": "+254712345678", "pin": "482913" }`.
2. On success, response shape is **identical to `POST /auth/login`**:
   ```json
   { "success": true, "data": { "accessToken": "...", "refreshToken": "...", "user": { "...": "...", "mustChangePassword": true }, "requiresPasswordChange": true }, "error": null }
   ```
   Tokens are real and immediately usable — this is a full login, not a partial/limited session.
3. **Frontend must check `data.requiresPasswordChange` (or `data.user.mustChangePassword` — same value, mirrored in both places) from the response body.** This flag is *not* encoded inside the JWT itself — don't try to decode the access token client-side to read it; use the login/verify-pin response payload.
4. If `true`, redirect straight to a "Create Your Password" screen. Every other authenticated endpoint will 403 until this is done (enforced server-side by `JwtAuthGuard`), so there's no way to skip it even if the frontend routing has a bug.
5. User submits new password: **`PATCH /auth/change-password`** 🔒 with:
   ```json
   { "newPassword": "NewSecure@2025", "confirmPassword": "NewSecure@2025" }
   ```
   **Do not send `currentPassword`** — the account has none yet (PIN was the auth factor). If you send it anyway it's simply ignored for first-time onboarding accounts; it only becomes required for a normal password change on an already-onboarded account.
6. On success, redirect to the standard dashboard. The existing access token from step 2 stays valid (no new login required).

## Flow 3 — Password Reset / Lost Initial PIN

Same two endpoints handle both "I forgot my password" and "I never got/lost my first PIN" —
the backend doesn't need to know which case it is.

1. User calls **`POST /auth/request-password-reset`** (public) with `{ "phone": "+254712345678" }`.
2. **Always show the same generic success message regardless of the response** (the API always returns 200 whether or not the phone number is registered — this is intentional, to prevent attackers from using this endpoint to enumerate registered phone numbers): *"If the phone number is registered, a PIN has been sent."*
3. User enters the PIN + new password on the frontend, which calls **`POST /auth/reset-password/confirm`** (public):
   ```json
   { "phone": "+254712345678", "pin": "482913", "newPassword": "NewSecure@2025", "confirmPassword": "NewSecure@2025" }
   ```
4. On success (`{ "success": true, "message": "..." }`), **no tokens are issued** — redirect to the standard login screen (`POST /auth/login`) with the new password.

### PIN facts (both flows)

- 4-6 digits (tenant-configurable, defaults to 6).
- Expires in **20 minutes**.
- Max **5 verification attempts** before the PIN is invalidated outright (a fresh one must be requested).
- Single-use — consumed on first correct entry.

---

## Error Handling

| Status | When | Suggested UI |
|---|---|---|
| `401` | Wrong PIN/password, or PIN expired (`verify-pin`, `login`) | "Invalid phone number or PIN" — don't distinguish which one was wrong. |
| `400` | Invalid/expired PIN or password mismatch (`reset-password/confirm`, `change-password`), or admin PIN action on an already-onboarded user | Show the `message` field directly — these are already user-safe strings. |
| `429` | Rate limit exceeded (see table below) | *"Too many attempts. Please try again in a few minutes."* The API does not currently return a `Retry-After` value or exact seconds remaining — don't try to render a live countdown; a generic retry message is sufficient. |

### Rate limits to be aware of (for UX copy, not enforcement — the backend enforces these regardless)

| Endpoint | Limit |
|---|---|
| `POST /auth/verify-pin` | 5 / minute / IP |
| `POST /auth/reset-password/confirm` | 5 / minute / IP |
| `POST /auth/request-password-reset` | 3 / hour / IP **and** 3 / hour per IP+phone pair |
| `POST /users/:id/resend-pin` | 5 / minute / IP **and** 5 / hour per admin |
| `POST /users/:id/reveal-pin` | 5 / minute / IP **and** 5 / hour per admin |

---

## Endpoint Reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/users` | 🔒 `TENANT_ADMIN`/`MANAGER` | Create user, auto-sends first-login PIN |
| POST | `/users/:id/reveal-pin` | 🔒 `TENANT_ADMIN` | Regenerate + return PIN to admin |
| POST | `/users/:id/resend-pin` | 🔒 `TENANT_ADMIN`/`MANAGER` | Regenerate + SMS only, no reveal |
| POST | `/auth/verify-pin` | Public | First-login PIN → full session |
| PATCH | `/auth/change-password` | 🔒 any authenticated user | Set/change password |
| POST | `/auth/request-password-reset` | Public | Request reset PIN via SMS |
| POST | `/auth/reset-password/confirm` | Public | Verify reset PIN + set new password |
| POST | `/auth/login` | Public | Standard phone/email + password login |

### Legacy endpoints — do not build against these for new frontend work

`POST /auth/forgot-password`, `POST /auth/reset-password` (token-based), and
`POST /auth/password-reset/request` / `POST /auth/password-reset/verify` are an older
email-link and email/SMS-OTP flow that predate the PIN system above. They still work
(some existing clients depend on them) and are documented in Swagger with an explicit
"legacy" note, but the new web app should use only the endpoints in the table above.
