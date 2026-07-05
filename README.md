# PrintQ

Campus print-queue platform: students submit fully-specified, pre-paid print jobs from
their phone and join a virtual queue; the shop owner's job collapses to *"confirm an
OTP, hand over the print."*

Spec: [printQ.md](./printQ.md) · Engineering plan: [PLAN.md](./PLAN.md) · Security posture: [SECURITY.md](./SECURITY.md)

## What's in the box (Phase 1 — single-shop pilot)

| Piece | Path | What it does |
|---|---|---|
| API + workers | `apps/api` | Express 5 + Prisma/Postgres + BullMQ/Redis + Socket.io. Auth, uploads, conversion, pricing, payments, queue engine, OTP release, agent dispatch |
| Web app | `apps/web` | One Vite/React PWA: student flow (`/s/:shopSlug`) + shop dashboard (`/dashboard`) |
| Print agent | `apps/agent` | Node CLI on the shop PC — receives dispatches over WebSocket, prints via OS spooler |
| Shared | `packages/shared` | Job state machine, pricing engine, printer-assignment algorithm, zod schemas |

## Quick start (dev)

Prereqs: Node ≥ 20, Docker Desktop.

```bash
npm install
docker compose up -d postgres redis     # Postgres on 15432, Redis on 6380
cp .env.example .env                    # then set JWT_SECRET + OTP_PEPPER (openssl rand -hex 32)
cp .env apps/api/.env
npm run db:migrate -w apps/api          # prisma migrate dev
npm run db:seed                         # demo shop + owner login + 2 printers
npm run dev:api                         # API + workers on :4000
npm run dev:web                         # web on :5173
```

Seeded logins:
- Student page: `http://localhost:5173/s/demo` (any Indian mobile number; the login
  OTP prints in the **API console** while `NOTIFICATION_PROVIDER=console`)
- Dashboard: `http://localhost:5173/dashboard` → `owner@demo.printq.local` / `demo-owner-pass-1`
- Payments default to `PAYMENT_PROVIDER=mock` — the "Pay & join queue" button simulates
  a captured payment via a dev-only endpoint that is hard-disabled when Razorpay is configured.

### Print agent (on the shop PC)

1. Dashboard → Agents → *Register this PC* → copy the one-time token.
2. On that PC:
   ```powershell
   $env:PRINTQ_API_URL = "http://<api-host>:4000"
   $env:PRINTQ_AGENT_TOKEN = "<token>"
   $env:PRINTER_MAP = '{"<printq-printer-uuid>":"HP LaserJet 1020"}'   # OS printer name
   npm run dev:agent
   ```
   Windows printing uses `pdf-to-printer` (SumatraPDF under the hood).

### DOCX conversion

Needs LibreOffice. Set `SOFFICE_PATH` in `.env`
(e.g. `C:\Program Files\LibreOffice\program\soffice.exe`). Without it, PDF/JPG/PNG
still work and DOCX uploads fail with a clear message.

## The job lifecycle

```
pending_payment → queued → notified → otp_verified → printing → ready_for_pickup → completed
                     ↓         ↓ (window expires)
                 cancelled   no_show → requeued → queued   (one free requeue)
                                    → expired               (grace passes / 2nd no-show)
```

Every transition goes through one function (`packages/shared/src/stateMachine.ts`) and
writes an append-only `JobEvent` audit row. Payment truth comes only from the verified
webhook (or the mock endpoint in dev) — never from the client redirect.

## Going to production

External accounts you must set up (see PLAN.md §9 for details):

1. **Hosting** — any Node host + managed Postgres + Redis (Railway / Fly.io / VPS).
   Build: `npm run build`, run `node apps/api/dist/server.js` (workers run in-process;
   set `RUN_WORKERS=false` and run `dist/worker.js` separately to scale out).
   Apply migrations with `npm run db:deploy -w apps/api`.
2. **Razorpay** — set `PAYMENT_PROVIDER=razorpay` + keys + webhook secret; point the
   webhook at `POST /api/payments/webhook/razorpay` (event: `payment.captured`).
3. **WhatsApp** — Meta Cloud API number + access token; `NOTIFICATION_PROVIDER=whatsapp`.
4. **Object storage** — `STORAGE_DRIVER=s3` + any S3-compatible bucket (R2/S3/MinIO).
5. **TLS + CORS** — terminate TLS at your proxy; set `CORS_ORIGINS` to your web origin(s)
   and `PUBLIC_WEB_URL` to the deployed web URL.

## Tests

```bash
npm test          # state machine, pricing, page ranges, printer assignment, OTP hashing
npm run typecheck # all four workspaces
```

## Known Phase 1 limitations (deliberate, per spec §13)

- Instant queue only — scheduled slots + reserved capacity are Phase 2.
- CAD/DWG conversion not included (Phase 2, likely via a conversion API).
- Converted-PDF paper-size vs. selected-size mismatch is not blocked at checkout;
  printers scale-to-fit. Strict validation is a Phase 2 nicety.
- Shop onboarding is via seed script / DB — a self-serve signup UI is Phase 2+.
