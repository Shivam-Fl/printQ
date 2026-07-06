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
  code prints in the **API console** — look for `loginCode`)
- Dashboard: `http://localhost:5173/dashboard` → `owner@demo.printq.local` / `demo-owner-pass-1`
  (or register a new shop at `/dashboard/register`)
- Payments default to `PAYMENT_PROVIDER=mock` — the "Pay & join queue" button simulates
  a captured payment via a dev-only endpoint that is hard-disabled when Razorpay is configured.

### Notifications (no WhatsApp needed)

Everything is in-app first:
- The **release OTP shows inside the app** on the job page (and via socket the moment
  it's your turn) — the student just shows their phone at the counter.
- An **"almost your turn" alert** fires when ≤ `NEAR_FRONT_THRESHOLD` (default 5)
  people are ahead.
- **Web Push** reaches the installed PWA even when closed. Enabled out of the box in
  dev (VAPID keys in `.env`); for a fresh setup run `npx web-push generate-vapid-keys`.
- Login codes print to the API console in dev; wire an SMS provider into
  `sendLoginOtp()` (one function) for launch.

### Scheduled slots (Phase 2)

Students can pick **"Print now"** or **"Pick a slot"** (15 min – 72 h ahead). A booked
slot job waits invisibly, becomes *due* `SCHEDULE_LEAD_MINUTES` (default 10) before its
time, and then alternates fairly with walk-in jobs (~50/50) so neither group is starved.
The dashboard shows booked slots in their own section.

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
   Build: `npm run build`, run `node apps/api/dist/server.js` — in production it also
   **serves the built web app** from the same origin (PWA + push + API on one domain).
   Workers run in-process; set `RUN_WORKERS=false` and run `dist/worker.js` separately
   to scale out. Apply migrations with `npm run db:deploy -w apps/api`.
2. **Razorpay** — set `PAYMENT_PROVIDER=razorpay` + keys + webhook secret; point the
   webhook at `POST /api/payments/webhook/razorpay` (event: `payment.captured`).
3. **SMS for login codes** — any provider (MSG91 etc.) wired into `sendLoginOtp()`.
   All other notifications are in-app + Web Push, no messaging vendor needed.
4. **Object storage** — `STORAGE_DRIVER=s3` + any S3-compatible bucket (R2/S3/MinIO).
5. **TLS + CORS** — HTTPS is required for PWA install + push; set `CORS_ORIGINS` and
   `PUBLIC_WEB_URL` to the deployed URL.

## Tests

```bash
npm test          # state machine, pricing, page ranges, printer assignment, OTP hashing
npm run typecheck # all four workspaces
```

## Remaining known limitations

- CAD/DWG conversion not included (needs a third-party conversion API — pick one when
  a pilot shop actually asks for it).
- Converted-PDF paper-size vs. selected-size mismatch is not blocked at checkout;
  printers scale-to-fit.
- iOS web push requires the PWA to be installed (Add to Home Screen) — an Android-first
  pilot is unaffected.
