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

## Login OTPs and counter codes

- 6 digits from `crypto.randomInt`. Login OTPs are argon2id-hashed with a server-side
  pepper (`OTP_PEPPER`), 5 min expiry, 5 attempts, single-use.
- Counter release codes are six digits, shop-scoped and bound to one paid job. A
  peppered HMAC supports constant database lookup; the recoverable value is stored
  only as AES-256-GCM ciphertext with the shop id as authenticated data. Plaintext is
  returned only through the owning student's authenticated job route.
- Counter-code verification is rate-limited. It can release an `awaiting_arrival`,
  checked-in, or safely skipped legacy job, but optimistic state transitions prevent
  duplicate dispatch. Codes are deliberately stable through re-check-in so a refresh
  or missed position does not strand a paid document.
- Delivery is in-app: the student's authenticated socket room + Web Push to their own
  subscribed devices. No third-party messaging vendor sees counter codes.

## Payments

- The client sends **specs only**; price is computed server-side from the shop rate
  card in integer paise (`packages/shared/src/pricing.ts`).
- A verified Razorpay webhook (HMAC-SHA256 over the raw body, constant-time compare)
  moves a job to `awaiting_arrival`; payment/upload time never reserves a queue place.
  Only the authenticated arrival endpoint writes `queuedAt`. The mock path is
  hard-disabled unless `PAYMENT_PROVIDER=mock`; checkout callbacks are never trusted.
- Webhook idempotency via `PaymentEvent.providerEventId` (unique).

## Files

- Magic-byte validation (`file-type`), 25 MB cap enforced by multer, random UUID
  storage keys (user filenames never touch the filesystem), path-traversal guard in
  the local driver, `Content-Security-Policy: sandbox` on inline PDF previews.
  A spool acknowledgement is not successful-print evidence: only an isolated
  simulator completion or authenticated staff's physical confirmation starts the
  fixed ten-minute deletion clock. The minute worker deletes source, converted
  and preview objects, then scrubs stored filenames while retaining audit metadata.
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
- **Refunds**: `refundIfPaid()` atomically reserves work with `paid → refunding` *before* calling
  the provider. A retry/race is therefore a no-op rather than a second external refund; provider
  failure safely returns the job to `paid`. Amounts come from stored `totalPaise`, never the client.
- **SMS/Email providers** are pluggable (`SmsProvider`, `EmailProvider`) with a `console` default
  that never leaves the server — real delivery only turns on when the founder sets
  `SMS_PROVIDER=msg91` / `EMAIL_PROVIDER=resend` with real credentials (`PLAN.md` §9).
- **Printer auto-setup**: an agent's reported `detectedPrinters` list only ever links to a
  `Printer` row already scoped to that agent's own shop (`shopId` in every relevant query) — one
  shop's agent can never see or claim another shop's printers or jobs.
- **Operational availability**: a printer is offered to students and the assignment engine only
  while an authenticated, online agent reports that it can reach that exact printer. A stale
  database `online` switch alone cannot accept paid work. Staff can pause new sales without
  invalidating existing paid codes or preventing pickup work.
- **Print recovery**: spooler failures are persisted on the job, the agent claim is released, and
  the shop can retry after fixing the device without regenerating or re-entering the student's OTP.
- **Retention**: the deletion clock starts at upload (covering abandoned previews/checkouts) and is
  restarted at every terminal job outcome. Cleanup rechecks for active jobs—including prepared
  paid orders—before deleting bytes. Prepared orders that never arrive are automatically cancelled
  and refunded after `PREPARED_ORDER_TTL_HOURS`; an hourly DB sweep also retries terminal refunds
  after provider outages.

## Arrival and queue integrity

- The live line contains only students who explicitly checked in. It is one shop-wide order,
  even when several printers are running, so students never see duplicate position numbers.
- Repeated check-in calls are idempotent. If staff removes an absent student, the paid order and
  code remain valid but `queuedAt` is cleared; the next check-in uses the new arrival time and
  therefore goes to the end.
- Queue order is an organization aid, not an execution lock. Staff can enter the code for the
  person actually at the counter and dispatch that job without waiting on an absent front entry.

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
