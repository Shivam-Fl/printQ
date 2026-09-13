# PrintQ

Production domain: **PrintQs.com**, pronounced “print queues.” The interface
keeps the concise **PrintQ** mark; the domain/PWA identity uses **PrintQs**.

Campus printing platform: students prepare and pay for fully specified jobs from
anywhere, then join the shop's walk-in line only after they physically arrive. The
shop owner's main action is *"enter the counter code, hand over the print."*

Spec: [printQ.md](./printQ.md) · Engineering plan: [PLAN.md](./PLAN.md) · Security posture: [SECURITY.md](./SECURITY.md)

## What's in the box

| Piece | Path | What it does |
|---|---|---|
| API + workers | `apps/api` | Express 5 + Prisma/Postgres + BullMQ/Redis + Socket.io. Auth, uploads, conversion, pricing, payments, arrival queue, counter-code release, agent dispatch |
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
- Payments default to `PAYMENT_PROVIDER=mock` — the "Pay & prepare order" button simulates
  a captured payment via a dev-only endpoint that is hard-disabled when Razorpay is configured.

### Notifications (no WhatsApp needed)

Everything is in-app first:
- A stable six-digit **counter code** appears after payment. It is encrypted at rest,
  remains the same through check-in/removal/re-check-in, and lets staff find the paid
  job without making queue order a printer lock.
- An **"almost your turn" alert** fires when ≤ `NEAR_FRONT_THRESHOLD` (default 5)
  people are ahead.
- **Web Push** reaches the installed PWA even when closed. Enabled out of the box in
  dev (VAPID keys in `.env`); for a fresh setup run `npx web-push generate-vapid-keys`.
- Login codes print to the API console in dev; wire an SMS provider into
  `sendLoginOtp()` (one function) for launch.

### Planned arrivals

Students can choose a flexible arrival or save a planned time (15 min–72 h ahead).
This is a reminder, not a remote queue reservation. Check-in opens
`SCHEDULE_LEAD_MINUTES` (default 10) before the planned time and always records the
student's real arrival time. A fresh one-time browser location reading must also be
inside the shop's owner-configured geofence; PrintQ stores the result, not the
student's raw coordinates.

### Print agent (on the shop PC)

1. Dashboard → **Setup** → **Connect computer**.
2. Choose **Real printer** or **Simulation**, name the computer, and click **Create connection**.
3. Download the generated Windows setup script and run it on the counter PC. It installs the
   packaged agent, starts it, and adds it to that Windows account's Startup folder.
4. Any printer detected from Windows appears on **Printers** for one-click capability setup.

For source development use `npm run dev:agent`; for hardware-free development use
`npm run dev:agent:sim`. Windows printing uses `pdf-to-printer` (SumatraPDF under the hood).

### DOCX conversion

Needs LibreOffice. Set `SOFFICE_PATH` in `.env`
(e.g. `C:\Program Files\LibreOffice\program\soffice.exe`). Without it, PDF/JPG/PNG
still work and DOCX uploads fail with a clear message.

## The job lifecycle

```
pending_payment → awaiting_arrival → queued → otp_verified → printing → ready_for_pickup → completed
                         ↑             ↓
                         └─ removed ───┘  (re-check-in joins at the end)
                         └──────── counter-code override ──→ otp_verified
```

Payment/upload time never creates a position. `queuedAt` is written only by the
arrival endpoint. Queue positions are shop-wide and advisory: staff can remove an
absent person without cancelling the order, and a later check-in goes to the end.
The code can still release the document directly when the student is at the counter.
Staff can pause new sales while finishing all previously paid work. Unused prepared
orders are automatically closed/refunded after `PREPARED_ORDER_TTL_HOURS` (default 168).

Every transition goes through one function (`packages/shared/src/stateMachine.ts`) and
writes an append-only `JobEvent` audit row. Payment truth comes only from the verified
webhook (or the mock endpoint in dev) — never from the client redirect.

## Pricing, earnings and payouts

The shop owner controls the private base rate card by paper, B/W or colour, and
finishing option. PrintQ applies `PLATFORM_MARKUP_BPS` server-side (2500 = 25%)
and snapshots both amounts on the order, so later rate changes never rewrite old
orders. Students see only one final payable amount—not the shop base, PrintQ
markup, gateway fee, or an itemized price split—in the storefront, checkout,
order API and student receipt.

A paid order does not become shop earnings until the print agent confirms that
the physical print succeeded. The append-only owner ledger credits the original
shop-base snapshot exactly once. Owners can choose daily aggregate payouts or
request their full available balance on demand; payout reservations prevent the
same earnings being sent twice. `SHOP_PAYOUT_PROVIDER=mock` exercises this whole
flow safely. Production uses Razorpay Route Direct Transfers to KYC-verified
Linked Accounts and authenticated transfer webhooks.

## Going to production

Start with [`LAUNCH_PLAN.md`](./LAUNCH_PLAN.md) for the real-student rollout,
campus-based shop discovery and privacy-safe nearby-search design, then use
[`DEPLOY.md`](./DEPLOY.md) as the operational runbook.

External accounts you must set up (see PLAN.md §9 for details):

See [`COST_MODEL.md`](./COST_MODEL.md) for the dated Firebase-versus-Render
recommendation and volume-based monthly estimates.

1. **Hosting** — any Node host + managed Postgres + Redis (Railway / Fly.io / VPS).
   Build: `npm run build`, run `node apps/api/dist/server.js` — in production it also
   **serves the built web app** from the same origin (PWA + push + API on one domain).
   Workers run in-process; set `RUN_WORKERS=false` and run `dist/worker.js` separately
   to scale out. Apply migrations with `npm run db:deploy -w apps/api`.
2. **Razorpay** — set `PAYMENT_PROVIDER=razorpay` plus the keys and webhook secret.
   For owner payouts, activate Route/Direct Transfers, onboard each shop as a
   Linked Account, and set `SHOP_PAYOUT_PROVIDER=razorpay_route`. Point the webhook
   at `POST /api/payments/webhook/razorpay` for payment and transfer events.
3. **Student login codes** — production uses Firebase Phone Auth. Set
   `STUDENT_AUTH_PROVIDER=firebase` + `FIREBASE_AUTH_API_KEY` on the API and the
   matching public `VITE_FIREBASE_*` values on the web build. The local server-OTP
   fallback can still use MSG91 via the three `MSG91_*` values.
   All other notifications are in-app + Web Push, no messaging vendor needed.
4. **Object storage** — `STORAGE_DRIVER=s3` + any S3-compatible bucket (R2/S3/MinIO).
5. **TLS + CORS** — HTTPS is required for PWA install + push; set `CORS_ORIGINS` and
   `PUBLIC_WEB_URL` to the deployed URL.

## Tests

```bash
npm test          # state machine, pricing, page ranges, assignment, OTP/code security
npm run typecheck # all four workspaces
npm run test:launch # production build + unit suites + real API/agent simulator E2E
```

The 64-assertion launch E2E covers private marketplace pricing and payout accounting,
remote preparation, geofence rejection, arrival check-in, shop-wide
positions, duplicate check-in, skipped students, out-of-order counter-code release,
storefront pause/reopen with existing-order protection, virtual printer jams/retry,
pickup, cancellation and exactly-once refunds.

## Remaining known limitations

- CAD/DWG conversion not included (needs a third-party conversion API — pick one when
  a pilot shop actually asks for it).
- Converted-PDF paper-size vs. selected-size mismatch is not blocked at checkout;
  printers scale-to-fit.
- iOS web push requires the PWA to be installed (Add to Home Screen) — an Android-first
  pilot is unaffected.
