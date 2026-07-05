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

- 6 digits from `crypto.randomInt`, argon2id-hashed with a server-side pepper
  (`OTP_PEPPER`) — plaintext is never persisted.
- Release OTPs: single-use, bound to one job, ~10 min expiry
  (`OTP_WINDOW_MINUTES`), invalidated on no-show. Login OTPs: 5 min expiry,
  5 attempts, single-use.
- OTP delivery: WhatsApp (prod) and the student's own authenticated socket room —
  same trust boundary.

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

## Reporting

This is a pilot-stage project. Report issues to the repo owner directly.
