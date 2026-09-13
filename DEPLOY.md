# Deploying PrintQ

This is the operational runbook — read `PLAN.md` for the engineering rationale behind
these choices. Two phases: a **free testing week on Render**, then an **upgrade
checklist** for when you're ready to charge real students real money.

## Architecture (what's actually running)

One Docker image (`Dockerfile`, repo root), one Render web service (`render.yaml`):
the API, the built student/shop web app, and the BullMQ background workers
(file conversion, planned-arrival reminders, retention/refund sweeps) all run in a single process —
exactly the same "pilot mode" the codebase runs locally via `npm run dev:api`. See
`apps/api/src/server.ts` and `apps/api/src/app.ts` if you want the details.

**Checkout starts in dummy/mock mode** (`PAYMENT_PROVIDER=mock`) — every job
auto-confirms via `/api/payments/mock/confirm`, no Razorpay account needed to start
testing. Flip this to real payments whenever you're ready (Phase 2, step 6 below).

**Migrations run on container start, not as a separate deploy step** —
`preDeployCommand` needs a paid Render plan, so the image's own entrypoint
(`docker-entrypoint.sh`, set as the Dockerfile's `CMD`) runs `prisma migrate deploy`
immediately before starting the server instead. It's idempotent — a no-op if
there's nothing pending — so this is safe to run on every cold start, not just on
deploy.

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
4. **Check the public URLs and fill in secrets** — the current test deployment's
   `CORS_ORIGINS` and `PUBLIC_WEB_URL` are committed in `render.yaml` so an
   auto-deploy cannot erase them. If you create another service or add a custom
   domain, update both values in the Blueprint before deploying. Production refuses
   a wildcard origin by design (`apps/api/src/config/env.ts`). Then go to
   `printq-web` → Environment and set:
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
- [ ] Confirm the paid order says **awaiting arrival** and has no queue position. Tap
  **I'm at the shop** while physically inside the owner-configured arrival radius,
  confirm it becomes position 1, then remove it from the line in the dashboard and
  confirm a re-check-in goes to the end. Also verify a check-in from outside the
  radius is rejected while the permanent counter-code fallback still works.
- [ ] Upload a **DOCX** file specifically — this is the one path that needs
  LibreOffice; confirm it converts instead of failing.
- [ ] Register a shop, open **Setup**, connect a computer in **Simulation** mode, and run
  the downloaded Windows setup file. Confirm the setup score reaches 100% before using hardware.
- [ ] Repeat with **Real printer** on the counter PC. The agent auto-detects Windows printers;
  add one from the **Detected printers** panel and verify its paper/colour capabilities.
- [ ] Enter the six-digit counter code and confirm it finds/prints the job even after
  the student was removed from the advisory line.
- [ ] Pause new orders from the dashboard: the public storefront must close while
  already-paid counter codes still work; reopen it after the test.

### Known free-tier limitations (expected, not bugs)

| Limitation | Why | Impact this week |
|---|---|---|
| 30-60s cold start | Free web services sleep after 15 min idle | First request after a gap is slow — refresh once, it's normal |
| Postgres expires in 30 days | Render free-tier policy | Fine for a week; upgrade the database before day 30 (one click, no migration) |
| Redis has no persistence | Free Key Value doesn't persist to disk | A Redis restart loses conversion/reminder work and rate-limit counters. Prepared-order expiry and refund retry are DB-swept, but the other queues still require persistent Redis for launch. **Must fix before real launch** (see below) |
| Uploaded files can vanish | Free web services have an ephemeral filesystem (`STORAGE_DRIVER=local`); a spin-down wipes `./storage` | If a test spans an idle gap, a job's file may 404 — just re-upload. **Must fix before real launch** |

## Phase 2 — upgrading to a real launch

See `LAUNCH_PLAN.md` for the campus/nearby discovery architecture, verified-shop
onboarding, staged rollout and full real-student acceptance gates.

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
4. **Wire student phone authentication**: the production flow uses Firebase Phone
   Auth, matching Packkar. In Render set `STUDENT_AUTH_PROVIDER=firebase` and
   `FIREBASE_AUTH_API_KEY`. In Vercel set `VITE_STUDENT_AUTH_PROVIDER=firebase` plus
   the four public `VITE_FIREBASE_*` web-app values. Add every production frontend
   hostname to Firebase Authentication → Settings → Authorized domains. Keep
   `STUDENT_AUTH_PROVIDER=local` only for local development; that fallback can use
   `SMS_PROVIDER=msg91` or the API console.
5. **Wire real email delivery** (forgot-password): get a Resend account, set
   `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` / `EMAIL_FROM`.
6. **Wire real payments and shop payouts** (replacing both simulators): from your Razorpay account,
   Dashboard → Settings → API Keys → generate a key pair (start in **Test Mode** to
   dry-run the real checkout flow with fake money first, without needing a fully
   KYC-activated Live account). Add a webhook — Dashboard → Webhooks → Add New
   Webhook — pointing at `https://<your-url>/api/payments/webhook/razorpay`,
   subscribed to `payment.captured`, `transfer.processed`, `transfer.failed`, and
   `transfer.reversed`; copy the secret it shows you. Then in
   Render, set `PAYMENT_PROVIDER=razorpay` + `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`
   / `RAZORPAY_WEBHOOK_SECRET`.

   Ask Razorpay to activate **Route Direct Transfers**, then onboard and KYC each
   print shop as a Route Linked Account. Store the returned account id on the
   corresponding shop and set `SHOP_PAYOUT_PROVIDER=razorpay_route`. New linked
   accounts can have a cooling period before transfers are allowed. PrintQ credits
   a shop only after successful printing, then sends one aggregate daily or
   owner-requested transfer; it never creates one transfer per student payment.
   Keep `SHOP_PAYOUT_PROVIDER=mock` until test checkout, transfer webhooks, failed
   transfer balance restoration, and reconciliation have all passed. Route/Direct
   Transfer pricing is account-specific—confirm it with Razorpay before setting the
   platform margin. When you're ready for real money, switch the
   dashboard to Live Mode, generate a live key pair and a live-mode webhook, and swap
   those three values for the live ones.
7. **Optional: a custom domain** instead of `*.onrender.com` (Render supports this
   directly — Settings → Custom Domains) and/or **optional: move to Fly.io's Mumbai
   region** once real traffic makes the latency difference to Indian users worth
   feeling — the same `Dockerfile` works there unchanged, only the platform-specific
   config (`render.yaml` → `fly.toml`) would need writing.

### Required launch gate

Before giving the URL to a real student, all of these must be true:

- [ ] `npm run test:launch` passes locally (including the 64-assertion pricing/arrival/queue/printer/payout simulator E2E).
- [ ] Render Postgres, Key Value and web service use production-capable paid instances.
- [ ] `STORAGE_DRIVER=s3`; an upload survives a web-service restart and expires after retention.
- [ ] `PAYMENT_PROVIDER=razorpay`; test-mode payment, webhook capture, cancellation and refund pass.
- [ ] `SHOP_PAYOUT_PROVIDER=razorpay_route`; every live shop has a verified Linked
  Account and test transfer success/failure webhooks reconcile its private ledger.
- [ ] `STUDENT_AUTH_PROVIDER=firebase`; a real phone completes OTP login from every production domain.
- [ ] `EMAIL_PROVIDER=resend`; shop-owner reset messages arrive on real devices.
- [ ] VAPID keys are configured and an approaching-position notification opens the correct job from an installed PWA.
- [ ] A real Windows printer passes B/W, colour, duplex and multi-copy tests for every advertised option.
- [ ] Shop terms, privacy/contact details, Razorpay KYC and a support escalation path are in place.
