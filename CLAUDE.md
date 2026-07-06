# PrintQ — rules for AI-assisted sessions

Read `printQ.md` (product spec), `PLAN.md` (engineering plan) and `SECURITY.md`
(security decisions) before making changes.

## Hard rules — do not violate

- Never store secrets in code. All config goes through `apps/api/src/config/env.ts`
  (zod-validated). Add new vars to `.env.example` with placeholder values only.
- Every Prisma query touching user data must filter by the owner **in the WHERE
  clause** (`studentId` / `shopId` / `claimedByAgentId`). Return 404 for both missing
  and not-owned resources.
- Every new API route must use one of the auth middlewares
  (`requireStudent` / `requireShopUser` / `requireShopOwner` / `requireAgent`) unless
  it is genuinely public — and then say so in a comment.
- Job status changes only via `applyTransition()`
  (`apps/api/src/modules/jobs/transitions.ts`). Never `prisma.job.update({ status })`
  directly.
- Prices are computed server-side (`computePrice` in `packages/shared`). Never trust a
  client-supplied amount.
- No `$queryRawUnsafe`, no string-built SQL.
- OTPs and passwords are hashed (argon2id + pepper). Exception (deliberate):
  `Job.otpCode` keeps the release OTP in plaintext only while status is `notified`
  so the student's own app can show it — always null it on release/no-show/expiry.
  Pino redaction covers `*.otp`, `*.password`, `*.token`.
- Notifications are in-app first: `notifyStudent()` (socket + Web Push). No WhatsApp.
  BullMQ custom job ids must not contain `:` — use dashes.
- Payment state changes only from verified webhooks (or the mock provider in dev).
- Wrap async Express handlers in `asyncHandler`; let the global error handler shape
  responses (no `err.message` pass-through for unexpected errors).

## Conventions

- npm workspaces monorepo; TypeScript ESM everywhere (`.js` import suffixes).
- Dev infra: `docker compose up -d postgres redis` (host ports **15432** / **6380** —
  5432/6379 are taken by other local services).
- Schema changes: edit `apps/api/prisma/schema.prisma` → `npm run db:migrate -w apps/api`.
  Never hand-apply SQL.
- Run `npm run typecheck` and `npm test` before considering a change done.
