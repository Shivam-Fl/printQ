# PrintQ — Production Build Plan (Phase 1)

> Companion to `printQ.md` (the product spec). This document is the engineering plan:
> concrete stack choices, repo layout, security posture, and build order for a
> production-ready, launch-ready Phase 1 (single-shop pilot).

---

## 1. Stack decisions (locked)

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript everywhere (API, web, agent, shared) | One language, shared types across all four surfaces |
| Backend | Node.js + Express 5 | Spec-recommended; middleware ecosystem for helmet/rate-limit/CORS |
| ORM / DB | Prisma + PostgreSQL 16 | Parameterized by default (kills SQLi), migration workflow built in |
| Cache / queues | Redis 7 (BullMQ for jobs, rate-limit store, Socket.io adapter) | One infra piece, three uses |
| Realtime | Socket.io (rooms per shop / per job / per agent) | Live queue positions + agent dispatch |
| File storage | Local-disk driver (dev) / S3-compatible driver (prod, incl. Cloudflare R2 & MinIO) behind one `Storage` interface | Signed URLs, no files under web root |
| File conversion | BullMQ worker: `pdf-lib` (PDF normalize + page count), `sharp` (image → PDF), headless LibreOffice `soffice` (DOCX → PDF) | Async, retried, never blocks a request |
| Payments | `PaymentProvider` interface: `MockProvider` (dev/pilot-dry-run) + `RazorpayProvider` (UPI; HMAC-verified webhook) | Swap by env var; server computes price, never trusts client |
| Notifications | `NotificationProvider` interface: `ConsoleProvider` (dev) + `MetaWhatsAppProvider` (Meta Cloud API) | Real provider needs user's WABA account — config-driven, not blocking |
| Student app + shop dashboard | One Vite + React PWA, route-split (`/s/:shopSlug/**` student, `/dashboard/**` owner) | One deploy, code-split bundles, mobile-first student side |
| Print agent | Node CLI app (`pdf-to-printer` on Windows, `unix-print` elsewhere), authenticated WebSocket to API | Only way to reach a physical spooler |
| Monorepo | npm workspaces: `apps/api`, `apps/web`, `apps/agent`, `packages/shared` | No extra tooling beyond npm |
| Tests | Vitest (unit: state machine, pricing, assignment, OTP) + supertest (API integration) | Fast, TS-native |
| CI | GitHub Actions: typecheck, lint, test, `npm audit` | Catches regressions from future AI-assisted sessions |

## 2. Repo layout

```
printQ/
├─ apps/
│  ├─ api/            Express API + BullMQ workers (one deployable; worker via WORKER=1)
│  │  ├─ prisma/      schema.prisma + migrations
│  │  └─ src/
│  │     ├─ config/   env parsing (zod-validated, fail-fast)
│  │     ├─ middleware/  auth, rate limits, error handler, validation
│  │     ├─ modules/  auth/ shops/ printers/ jobs/ queue/ payments/ files/ agents/
│  │     ├─ providers/  storage/ payment/ notification/
│  │     ├─ realtime/ socket.io setup, rooms, auth handshake
│  │     └─ workers/  conversion worker, no-show sweeper
│  ├─ web/            Vite React PWA (student + dashboard)
│  └─ agent/          print agent CLI
├─ packages/shared/   types, job state machine, zod DTOs, pricing engine
├─ docker-compose.yml postgres + redis + minio (dev infra)
├─ .env.example       every var documented, placeholders only
└─ .github/workflows/ci.yml
```

## 3. Data model (extends spec §7 for production)

Spec entities kept, plus production columns:

- **ShopUser** (owner/staff login): `email`, `password_hash` (argon2id), `role`.
- **Student**: phone auth. `phone_number` unique, E.164.
- **LoginOtp**: hashed login OTPs (argon2), attempts counter, expiry — students log in via phone OTP.
- **Job** additions: `otp_hash` (never store plaintext release OTP), `otp_attempts`, `no_show_count`, `requeued_at`, `payment_provider`, `idempotency keys` on payment events, `expires_file_at` (24h auto-delete), `pages` (from conversion), `price_breakdown` (JSONB, server-computed).
- **PaymentEvent**: provider event id (unique) → webhook idempotency.
- **JobEvent**: append-only audit log of every state transition (who, when, from → to).
- **Agent**: `token_hash` (agent authenticates with a one-time-shown token), heartbeats.
- Indexes: `Job(shop_id, status)`, `Job(assigned_printer_id, status, queue_position)`, `Job(student_id, created_at)`, `PaymentEvent(provider_event_id)`, `LoginOtp(phone, created_at)`.

## 4. State machine (spec §8, enforced centrally)

Single `transition(job, event)` function in `packages/shared` — the only way status changes.
Illegal transitions throw; every transition writes a `JobEvent` row. States:
`pending_payment → queued → notified → otp_verified → printing → ready_for_pickup → completed`,
branches `notified → no_show → requeued|expired`, `queued|notified → cancelled`.

## 5. Queue engine

- `queue_position` computed per printer: paid jobs ordered by `queued_at` (requeued jobs keep original timestamp — one free requeue shouldn't send you to the back… actually spec says "rejoins the line"; decision: requeue puts job at **front of queue** within grace period, since student already waited — documented, configurable).
- When a printer's front job changes → notify that student (WhatsApp/console), generate OTP (6-digit, hashed, 10-min expiry, max 5 verify attempts), start no-show window.
- **No-show sweeper**: BullMQ delayed job per notification (not cron-polling) → fires at window expiry → if still `notified`, mark `no_show`, notify next.
- Assignment algorithm exactly per spec §9: filter online + capability-match, rank by estimated completion (queue pages / ppm), auto-assign or highlighted recommendation.
- Fallback: no eligible printer in auto mode → job flagged `needs_manual_assign`, dashboard shows warning dropdown.

## 6. Security posture (from vibe-to-production checklist, baked in day one)

| Checklist item | How PrintQ handles it |
|---|---|
| Auth on every route | `requireStudent` / `requireShopUser` / `requireAgent` middleware; no unauthenticated data routes except shop public info |
| IDOR | Every query filters by owner in the WHERE clause (`{ id, studentId }` / `{ id, shopId }`), 404 not 403 |
| Secrets | `.env` gitignored from first commit; `.env.example` with placeholders; JWT + OTP pepper from env; config module fails fast if missing |
| Client-side secrets | Web app receives only `VITE_API_URL`; all provider keys server-side |
| SQL injection | Prisma only; `$queryRawUnsafe` banned (lint note in CLAUDE.md) |
| XSS | React auto-escaping; no `dangerouslySetInnerHTML` |
| CSRF | Bearer tokens (Authorization header), not cookies → classic CSRF not applicable; CORS allowlist enforced anyway |
| CORS | Explicit origin allowlist from env; no wildcard |
| Webhooks | Razorpay HMAC-SHA256 signature verified on raw body; event id idempotency table |
| Rate limiting | Redis-backed: login/OTP-request 5/min per phone+IP, OTP verify 10/min, uploads 10/min, general API 100/min |
| File uploads | Magic-byte validation (`file-type`), 25 MB cap enforced during stream, random storage keys, object storage / non-web-root, signed download URLs, auto-delete 24h after completion |
| Password hashing | argon2id for shop staff; login + release OTPs also hashed |
| Release OTP | 6-digit, single-use, job-bound, hashed at rest, 10-min expiry, 5 attempts then locked |
| Error handling | `asyncHandler` wrapper + global handler: generic client message, full pino structured log server-side |
| Headers | helmet defaults + HSTS |
| Price integrity | Server computes price from specs + shop rate card; client sends specs only, never a price |
| Payment truth | Job → `queued` only on verified webhook/capture, never on client redirect callback |
| Agent auth | Per-agent token (shown once, hashed in DB); agent socket scoped to own shop's jobs; claim/lock (`claimed_by_agent_id`) prevents double print |
| Observability | pino structured JSON logs, request ids, JobEvent audit trail; Sentry DSN hook (env-optional) |
| Supply chain | Only mainstream registry packages; CI runs `npm audit` |

## 7. What Phase 1 ships (definition of done = spec §15)

Student: phone-OTP login → upload (PDF/DOCX/JPG/PNG) → converted preview + page count →
specs + live server price → pay (mock or Razorpay UPI) → live queue position via WebSocket →
WhatsApp/console OTP when it's their turn.
Shop: staff login → printer profiles CRUD → auto-assign toggle → live queue dashboard →
single OTP input releases print (auto or dropdown) → no-show marking with auto-advance.
Agent: registers with token, heartbeats, receives dispatch, prints via OS spooler, confirms completion.

## 8. Deliberately deferred (Phase 2+, per spec §13)

Scheduled slots + reserved capacity, CAD conversion, multi-shop onboarding UI,
WhatsApp-bot ordering, analytics, platform admin.

## 9. External accounts the founder must set up (build doesn't block on these)

1. **Hosting** — API + worker need a Node host with Redis & Postgres (Railway/Fly.io/VPS). Web is static.
2. **Razorpay** — KYC'd account; set `RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET`. Until then `PAYMENT_PROVIDER=mock`.
3. **WhatsApp Business** — Meta Cloud API number + template approval; set `WHATSAPP_*` vars. Until then `NOTIFICATION_PROVIDER=console`.
4. **Object storage** — any S3-compatible bucket (R2 recommended). Until then `STORAGE_DRIVER=local`.
5. **Domain + TLS** — terminate TLS at the host/proxy; set `CORS_ORIGINS` + `PUBLIC_WEB_URL`.
