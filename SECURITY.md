# PrintQ Security Posture

This codebase was built against the vibe-to-production security checklist from day one.
This file records the decisions so future sessions (human or AI) don't undo them.

## Auth & access control

- **Students**: phone-OTP login → JWT (30d). **Shop staff**: email + argon2id password →
  JWT (12h) with `shopId` + `role` claims. **Agents**: opaque 48-hex token, shown once,
  stored as sha256 (`Agent.tokenHash`).
- Every data route requires one of `requireStudent` / `requireShopUser` /
  `requireShopOwner` / `requireAgent`. The only unauthenticated routes are
  `/healthz`, `GET /api/public/shops/:slug` (public shop info) and the auth endpoints.
- **IDOR**: ownership lives *inside the Prisma WHERE clause*
  (`{ id, studentId }` / `{ id, shopId }` / `{ id, claimedByAgentId }`) — never fetch by
  id then check. Missing and not-owned both return **404**.
- Login-OTP requests can't write profile data (name updates require a verified session).

## OTPs

- 6 digits from `crypto.randomInt`. Login OTPs are argon2id-hashed with a server-side
  pepper (`OTP_PEPPER`), 5 min expiry, 5 attempts, single-use.
- Release OTPs: single-use, bound to one job, ~10 min expiry (`OTP_WINDOW_MINUTES`),
  invalidated on no-show. Verification runs against the argon2 hash; the plaintext is
  additionally kept **only while the job is `notified`** so the owning student's app
  can display it (their own authenticated channel — deliberate product decision), and
  is nulled on release/no-show/expiry.
- Delivery is in-app: the student's authenticated socket room + Web Push to their own
  subscribed devices. No third-party messaging vendor sees OTPs.

## Payments

- The client sends **specs only**; price is computed server-side from the shop rate
  card in integer paise (`packages/shared/src/pricing.ts`).
- A job becomes `queued` only via the Razorpay webhook (HMAC-SHA256 verified on the
  raw body, constant-time compare) or the mock endpoint which is hard-disabled unless
  `PAYMENT_PROVIDER=mock`. Client checkout callbacks are never trusted.
- Webhook idempotency via `PaymentEvent.providerEventId` (unique).

## Files

- Magic-byte validation (`file-type`), 25 MB cap enforced by multer, random UUID
  storage keys (user filenames never touch the filesystem), path-traversal guard in
  the local driver, `Content-Security-Policy: sandbox` on inline PDF previews,
  auto-deletion `FILE_RETENTION_HOURS` after completion (privacy, spec §14).
- Agent file downloads require the agent to have *claimed* the job.

## Platform hygiene

- helmet, strict CORS allowlist from env (wildcard rejected in production),
  Redis-backed tiered rate limits (OTP request 5/min, verify 10/min, login 5/min,
  upload 10/min, general 300/min), 1 MB JSON body cap.
- Bearer tokens (no cookies) → classic CSRF doesn't apply; CORS still enforced.
- Errors: `HttpError` messages pass through; everything else returns a generic 500 and
  logs full detail server-side (pino, structured JSON, secrets redacted).
- Prisma only — no raw SQL. `$queryRawUnsafe` is banned (see CLAUDE.md).
- Env is zod-validated and fail-fast; `.env` is gitignored; `.env.example` has
  placeholders only. **If a real secret is ever committed, rotate it — removing the
  file is not enough.**
- Job status can only change through `applyTransition()` (shared state machine +
  optimistic-concurrency WHERE + append-only `JobEvent` audit rows).
- Agent claim/lock (`claimedByAgentId`, conditional update) prevents double-printing
  when several PCs reach the same printer.

## Phase 2 additions

- **Staff PINs**: counter staff (`ShopUser.role = 'staff'`) authenticate with a short numeric PIN
  (4-6 digits) instead of a full password, for fast entry on a shared PC. The PIN is hashed with
  the same argon2id call as owner passwords (`passwordHash` column is reused — the hash doesn't
  care about input shape). Only the owner can create or remove staff accounts
  (`requireShopOwner` on `/api/shop/staff*`); a staff account can never delete another account,
  including its own.
- **Forgot-password**: reset codes are hashed the same way as login OTPs (argon2id + `OTP_PEPPER`),
  15-minute expiry, 5 attempts, single-use, and the request route always returns `200 {ok:true}`
  regardless of whether the email exists (no account enumeration — same pattern as login).
- **Refunds**: `refundIfPaid()` only ever acts on a job it can see is `paymentStatus: paid`, and
  flips that status via a conditional `updateMany` (idempotent — a retry or race is a no-op, not
  a double refund). Refund amounts always come from the job's own stored `totalPaise`, never a
  client-supplied value.
- **SMS/Email providers** are pluggable (`SmsProvider`, `EmailProvider`) with a `console` default
  that never leaves the server — real delivery only turns on when the founder sets
  `SMS_PROVIDER=msg91` / `EMAIL_PROVIDER=resend` with real credentials (`PLAN.md` §9).
- **Printer auto-setup**: an agent's reported `detectedPrinters` list only ever links to a
  `Printer` row already scoped to that agent's own shop (`shopId` in every relevant query) — one
  shop's agent can never see or claim another shop's printers or jobs.

## Phase 4 additions

- **Coupons**: the client only ever sends a `couponCode` string — `percentOff`/`paiseOff` and all
  expiry/redemption-limit/shop-scope checks are resolved server-side
  (`apps/api/src/modules/jobs/coupons.ts`); a discount can never push a job below the platform's
  ₹1 minimum-order floor (`applyCoupon()` in `packages/shared/src/pricing.ts`).
- **Ratings**: a job can only be rated by its owning student (`studentId` in the WHERE clause),
  only once `status = 'completed'`, and only once ever (checked server-side, not just hidden in
  the UI).
- **Receipts/CSV**: both scoped by ownership the same way as every other job route (`studentId`
  or `shopId` in the query) — a student or shop can only ever download their own records.

## Reporting

This is a pilot-stage project. Report issues to the repo owner directly.
