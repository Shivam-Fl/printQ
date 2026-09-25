# Local isolated development QA — 2026-09-26 IST

This is an interim local QA run, **not** the final 164-case release matrix or a hosted development/production acceptance. Source was PR #25 branch `codex/render-prod-env-fix`, based on `94ed4d51c63ec6a3a99b8a39a700c4ee35b6308d`. The verified launch-copy fix is code commit `5e9cdbf6e6178770e8fe829306049d8a0042a081`.

## Isolation and services

- Docker Desktop engine 29.8.0 / Compose 5.5.1 was available. Compose project `printq-local-qa-20260926` started its own PostgreSQL 16 and Redis 7 containers on host ports 15432 and 6380. The clients used `127.0.0.1` on those ports. Other-project containers on 5432/6379 were not touched. The initial Compose port publishing was exposed on all host interfaces; the exact running configuration was observed, then all four optional/dev published ports were changed to loopback-only. The QA containers were recreated to verify the live bindings and stopped after QA. Their isolated volumes remain available for a rerun.
- A separate `printq_test` database was created in this QA PostgreSQL container. All commands set `NODE_ENV=test`, `PRINTQ_ENVIRONMENT=test`, `DATABASE_NAMESPACE=test`, isolated queue/storage namespaces, Redis DB 15, mock payment/payout, local student auth, console-only test email/SMS, and local storage. No production Firebase, Resend, GCS, Razorpay, or Render data/credentials were used.
- Docker's optional `minio/minio:latest` image could not be pulled (`repository does not exist`), so an S3-compatible storage browser journey was **not** run. Production GCS deletion/signature validity remains unverified.

## Commands and outcomes

| Check | Result |
| --- | --- |
| `npm run db:generate -w apps/api` | Pass |
| `npm run ci:integration:ready` against isolated QA PostgreSQL/Redis | Pass |
| `npm run db:deploy -w apps/api` on fresh `printq_test` | Pass; 29/29 migrations applied |
| `npx prisma migrate status --schema apps/api/prisma/schema.prisma` | Pass; schema up to date |
| `npm run build` | Pass; shared, API, agent/package, web |
| `npm run typecheck` | Pass; all four workspaces |
| `npm run test:ci` after the UI fix | Pass; 168 tests, zero failures/errors: shared 47, API 88, agent 14, web 19. Four JUnit XML files are alongside this report. |
| `npm run test:e2e:sim` after the UI fix | Pass; 93 assertions, including setup, arrival queue, cash/shop-UPI confirmation, simulated printer jam/retry, no premature commission, refund credit, no-show, override, and paused-shop existing orders. |
| `npm run test -w apps/web -- src/pages/student/PublicLaunchCopy.test.ts --silent` | Pass; 2 focused regressions. They failed first against the old text/dead link. |
| `npm run test -w apps/web -- --silent`, web typecheck, web production build | Pass; 19 tests; build retains existing >500 kB chunk warning. |
| Local browser at `http://127.0.0.1:5173/` with API at `http://127.0.0.1:4000/` | Homepage, verified-shop directory, student login, shop sign-in and recovery entry rendered. One simulator-created verified shop appeared as Offline, as expected after its agent stopped. The invalid `/s/demo` route was reproduced; homepage now links to `/shops`, and updated pay-at-shop copy was rechecked in the browser. No live-provider journey was claimed. |
| Fresh local-only browser signup | Pass: console-mock login code, name/profile setup, authenticated home, empty-state directory link, both primary and bottom `New print` actions routing to verified-shop directory, session surviving a page reload, and UI logout. No real SMS, Firebase, or production account was involved. |
| `node --test scripts/verify-local-compose.test.mjs` | Failed before the port-binding fix, passed after. `docker compose config --format json` and the recreated QA containers confirmed `127.0.0.1:15432` and `127.0.0.1:6380`; optional S3 ports are configured the same way. |

The first `test:ci` invocation failed 28 API suites because its `test` namespace was pointed at the Compose default `printq_development` database. The guard correctly rejected that mismatch. The failure report is retained under `initial-config-failure/api.junit.xml`. Creating and migrating an isolated `printq_test` database resolved the configuration error; the full rerun above passed.

The first browser OTP request was rejected with `Origin is not allowed`: the test API was configured for `http://localhost:4173`, while Vite was served at `http://127.0.0.1:5173`. Restarting only the local test API with that exact allowed origin resolved the mismatch. It was a QA harness configuration error, not an application-code fix; the subsequent fresh-signup browser journey passed.

## Still open

- The historical 164-case spreadsheet has **not** been cloned or rerun against a clean deployed candidate. Its prior 147 Pass / 17 Blocked statuses are historical, not current QA evidence. Current online-payment/payout case wording also needs migration to pay-at-shop/commission cases.
- No hosted development deployment was tested. Firebase token refresh, App Check/FCM, real Resend delivery, private GCS signed-URL invalidation after T+10 minutes, Razorpay TEST mandate/webhook reconciliation, physical Windows printer, and production-safe QA remain open.
- This run used local Docker and provider mocks. It does not authorize accepting real shop orders or enabling live money.
