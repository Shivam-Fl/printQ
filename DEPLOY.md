# Deploying PrintQ

This is the operational runbook — read `PLAN.md` for the engineering rationale behind
these choices. Two phases: a **free testing week on Render**, then an **upgrade
checklist** for when you're ready to charge real students real money.

## Architecture (what's actually running)

One Docker image (`Dockerfile`, repo root), one Render web service (`render.yaml`):
the API, the built student/shop web app, and the BullMQ background workers
(file conversion, no-show timers, scheduled slots) all run in a single process —
exactly the same "pilot mode" the codebase runs locally via `npm run dev:api`. See
`apps/api/src/server.ts` and `apps/api/src/app.ts` if you want the details.

**Checkout starts in dummy/mock mode** (`PAYMENT_PROVIDER=mock`) — every job
auto-confirms via `/api/payments/mock/confirm`, no Razorpay account needed to start
testing. Flip this to real payments whenever you're ready (Phase 2, step 6 below).

**Migrations run on container start, not as a separate deploy step** —
`preDeployCommand` needs a paid Render plan, so `render.yaml`'s `dockerCommand` runs
`prisma migrate deploy` immediately before starting the server instead
(`sh -c "npx prisma migrate deploy ... && node apps/api/dist/server.js"`). It's
idempotent — a no-op if there's nothing pending — so this is safe to run on every
cold start, not just on deploy.

## Phase 1 — free testing week

### One-time setup

1. **Push this repo to GitHub** if it isn't already (Render deploys from a connected
   GitHub repo).
2. **Generate a Web Push keypair** (needed for browser notifications):
   ```
   npx web-push generate-vapid-keys
   ```
   Keep the public/private key pair from the output — you'll paste them in step 4.
3. **Create the Render Blueprint**: in the Render dashboard, "New" → "Blueprint" →
   connect this GitHub repo → Render reads `render.yaml` and shows you `printq-web`
   (web service), `printq-db` (Postgres), `printq-redis` (Key Value) → click "Apply."
   First build takes a few minutes (it's compiling TypeScript and installing
   LibreOffice). Once it's live, note the assigned URL —
   `https://printq-web-xxxx.onrender.com` (Render appends a random suffix if the
   plain name is taken).
4. **Fill in the secrets** Render couldn't generate for you — go to `printq-web` →
   Environment, and set:
   - `CORS_ORIGINS` and `PUBLIC_WEB_URL` — both to the exact URL from step 3
     (e.g. `https://printq-web-xxxx.onrender.com`, no trailing slash). **The app will
     fail to boot without these set** — production refuses a wildcard/empty CORS
     origin by design (`apps/api/src/config/env.ts`).
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — from step 2.
   - `VAPID_SUBJECT` — `mailto:your-real-email@example.com` (Web Push requires a
     contact address; doesn't need to be public-facing, just valid).
   - Save changes — Render redeploys automatically.

   (No Razorpay account needed for this phase — `PAYMENT_PROVIDER=mock` is already
   set in `render.yaml`. See Phase 2 step 6 for going live with real payments.)
5. **Seed the demo shop** (optional, for your own testing): the existing
   `apps/api/prisma/seed.ts` seeds a demo shop/owner. Run it once against the deployed
   database from your machine: set `DATABASE_URL` locally to the value shown in the
   Render Postgres dashboard (Internal or External connection string — use the
   *External* one from your machine), then `npm run db:seed -w apps/api`.

### Smoke-test checklist

Work through this once the service is live and secrets are set:
- [ ] `https://<your-url>/healthz` returns `{"ok":true}`.
- [ ] Student phone login: request an OTP, then check the Render service's **Logs**
  tab for a `login_otp` line with the code (SMS delivery is `console` until you have
  an MSG91 account — this is expected, not a bug).
- [ ] Upload a PDF, set specs, and pay — checkout auto-confirms immediately
  (`PAYMENT_PROVIDER=mock`), no real payment happens yet.
- [ ] Upload a **DOCX** file specifically — this is the one path that needs
  LibreOffice; confirm it converts instead of failing.
- [ ] Register a shop, add a printer, register an agent, and run the real
  `apps/agent` from a Windows PC pointed at `PRINTQ_API_URL=https://<your-url>` — the
  agent auto-detects the PC's printers exactly like it does in local testing.
- [ ] Release a job by OTP and confirm it actually reaches that PC's printer.

### Known free-tier limitations (expected, not bugs)

| Limitation | Why | Impact this week |
|---|---|---|
| 30-60s cold start | Free web services sleep after 15 min idle | First request after a gap is slow — refresh once, it's normal |
| Postgres expires in 30 days | Render free-tier policy | Fine for a week; upgrade the database before day 30 (one click, no migration) |
| Redis has no persistence | Free Key Value doesn't persist to disk | A Redis restart loses in-flight no-show timers/scheduled-slot wake-ups and rate-limit counters. Re-test the affected job manually if you notice one stall. **Must fix before real launch** (see below) |
| Uploaded files can vanish | Free web services have an ephemeral filesystem (`STORAGE_DRIVER=local`); a spin-down wipes `./storage` | If a test spans an idle gap, a job's file may 404 — just re-upload. **Must fix before real launch** |

## Phase 2 — upgrading to a real launch

Do this before onboarding a real shop and real paying students:

1. **Upgrade `printq-db` and `printq-redis` off the free plan** in the Render
   dashboard (fixes the 30-day expiry and Redis persistence loss). No migration
   needed — same connection strings, Render handles the resize.
2. **Move file storage off local disk.** Create a Cloudflare R2 bucket (or any
   S3-compatible provider), set `STORAGE_DRIVER=s3` and the `S3_*` env vars
   (`apps/api/src/providers/storage/s3.ts` already implements this driver — it's a
   config flip, not new code). This also unlocks splitting BullMQ workers into their
   own Render service (`RUN_WORKERS=false` on `printq-web` + a second `type: worker`
   service running `node apps/api/dist/worker.js`) so a LibreOffice crash can't take
   the customer-facing API down with it — genuinely worth doing once you're not on
   the free tier's single-instance constraint anyway.
3. **Upgrade `printq-web` off the free plan** (removes cold starts and the 512MB
   ceiling — more headroom for LibreOffice under real load).
4. **Wire real SMS delivery**: get an MSG91 account, set `SMS_PROVIDER=msg91` +
   `MSG91_AUTH_KEY` / `MSG91_SENDER_ID` / `MSG91_TEMPLATE_ID`. Without this, real
   students have no way to receive their login OTP outside of your Render logs.
5. **Wire real email delivery** (forgot-password): get a Resend account, set
   `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` / `EMAIL_FROM`.
6. **Wire real payments** (replacing mock checkout): from your Razorpay account,
   Dashboard → Settings → API Keys → generate a key pair (start in **Test Mode** to
   dry-run the real checkout flow with fake money first, without needing a fully
   KYC-activated Live account). Add a webhook — Dashboard → Webhooks → Add New
   Webhook — pointing at `https://<your-url>/api/payments/webhook/razorpay`,
   subscribed to the `payment.captured` event; copy the secret it shows you. Then in
   Render, set `PAYMENT_PROVIDER=razorpay` + `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`
   / `RAZORPAY_WEBHOOK_SECRET`. When you're ready for real money, switch the
   dashboard to Live Mode, generate a live key pair and a live-mode webhook, and swap
   those three values for the live ones.
7. **Optional: a custom domain** instead of `*.onrender.com` (Render supports this
   directly — Settings → Custom Domains) and/or **optional: move to Fly.io's Mumbai
   region** once real traffic makes the latency difference to Indian users worth
   feeling — the same `Dockerfile` works there unchanged, only the platform-specific
   config (`render.yaml` → `fly.toml`) would need writing.
