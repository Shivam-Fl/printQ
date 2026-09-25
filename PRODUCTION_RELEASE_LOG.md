# PrintQs production release log

Last updated: 2026-09-26 IST. This is the durable handoff for every subsequent launch turn. Read and update it before changing any account, infrastructure, PR, or deployed revision. Record evidence, not inferred success. Never add credentials, reset codes, personal documents, or key values here.

## Decisions and release identity

- `master` is the user-selected production source; `development` is integration. `main` is unused. Changes go through feature PRs and CI; the owner authorized in-scope PR merges.
- The owner chose to keep the existing Render web, PostgreSQL, and Key Value services on **free** plans for now. Do not silently upgrade them. Development servers must be free/near-zero cost; paid production infrastructure is acceptable after a concrete cost check.
- Render is the requested near-term API host, with the existing dedicated `printqs-production` Firebase project for student identity. This is a user-directed pilot deviation from the canonical plan's Cloud Run target, not proof that the architecture is launch-complete.
- An immediate, separate owner confirmation is still required **immediately before** enabling live Razorpay keys, creating a production mandate, or any real shop debit. General merge/deploy authorization is not that confirmation.
- The source root `C:\Users\acer\Desktop\startup\printQ` has user-owned changes and must remain untouched. Worktree `C:\Users\acer\Desktop\startup\printQ-prod-env-fix`, branch `codex/render-prod-env-fix`, is isolated.

## Actual deployment and PR state

| Item | Verified state | Evidence / next action |
| --- | --- | --- |
| GitHub production branch | `origin/master` was `ff9f99fd2d2e28438fdc531875766c192026e359` when the Render failure was diagnosed. | Re-fetch before merging; this SHA passed master CI but **did not deploy**. |
| Render live API | Service `srv-dafems740ujc73b080e0`, `https://api.printqs.com`, was still running `d9319e858e98f2d60160b761402f6c10ea0eae25` (deploy `dep-daqjk73l550s73bp7u8g`). `/healthz` returned 200. | Recheck live SHA after the next deploy. Health alone is not release QA. |
| Failed candidate deploy | `dep-dar65rrncjis73c9iibg` built, applied 28 Prisma migrations, then exited: `STUDENT_AUTH_PROVIDER=firebase requires FIREBASE_PROJECT_ID`. | PR #25 pins the correct project and the existing database namespace; source has other production guards addressed below. Existing DB may now have newer schema than live code. |
| Active fix PR | [#25](https://github.com/Shivam-Fl/printQ/pull/25), branch `codex/render-prod-env-fix`. Firebase/DB fix SHA `9233a44ff5dcd60afe3f827c105062f1b79374d8` passed CI, QA, and Vercel checks. GCS/Resend Blueprint plus this log were pushed in commit `6558123`. | Check the current PR head and rerun required checks there; merge only when required runtime variables and email are verified. The latest PR head is authoritative, not a SHA copied into this file. |
| Paid-plan proposal | PR #24 was closed without merge at owner direction. | Do not reopen without a new price/plan decision. |

## Accounts and infrastructure inventory

| Platform / resource | Verified state | Cost or risk |
| --- | --- | --- |
| Render web `printq-web` | Free, combined API/conversion/worker process, auto-deploys `master`. | 512 MB / 0.1 CPU, sleeps after idle, ephemeral filesystem; cannot claim reliable real-order capacity. |
| Render PostgreSQL `printq-db` (`dpg-dafem4f40ujc73b059u0-a`) | Free, existing database name `printq_db_f68p`; 28 migrations applied by failed deployment. | 1 GB, no managed backups, scheduled free expiry 2026-10-07; real-order durability gate remains open. |
| Render Key Value `printq-redis` (`red-dafem4740ujc73b0596g`) | Free, existing production Redis. | 25 MB, memory-only; queue state can be lost on restart. Real print-order reliability gate remains open. |
| Firebase production | Dedicated project `printqs-production` exists. Render already had `FIREBASE_AUTH_API_KEY` by name; PR #25 pins `FIREBASE_PROJECT_ID=printqs-production`. | Do not use development Firebase users, credentials, or project. Auth/App Check/realtime/FCM live flows are not yet re-QA'd. |
| Google Cloud Storage production | Created `printqs-production-private` in `printqs-production`, Mumbai `asia-south1`, Standard, uniform access, public access prevention enforced, no soft delete/versioning/retention. Bucket initially empty. | Usage-based: Console showed $0.023/GB-month storage, plus operations/egress. Runtime deletion and signed-URL invalidation still need live QA. |
| Google service identity | Created `printqs-render-storage@printqs-production.iam.gserviceaccount.com` with `Storage Object Admin` on **that bucket only**, not the whole project. JSON key was put in Render Secret Files as `gcs-production-service-account.json`; the temporary local download was removed. | Rotate/revoke if compromise suspected. Never put JSON in Git or logs. Render ADC points to `/etc/secrets/gcs-production-service-account.json` in the pending Blueprint. |
| Resend | Owner Google account signed in; a sending-only production API key was created and saved as a protected Render `RESEND_API_KEY` variable without printing it. Domain `mail.printqs.com` added. | Plan/usage cap has not been audited. Sender verification is **pending**, so reset email is not yet production-ready. |
| GoDaddy DNS | `printqs.com` uses GoDaddy nameservers. Added exactly three mail-subdomain records: `rsend.mail` CNAME, `send.mail` CNAME, and `resend._domainkey.mail` TXT. Existing web/API DNS records were not edited. `Resolve-DnsName` found all three on 2026-09-26 IST. | Resend itself last reported `pending`; public DNS resolution is not equivalent to its verified status. Recheck there. |
| Razorpay | Production account/login and UPI AutoPay approval not reverified in this turn. No live keys, mandate, or debit enabled by this work. | Student checkout must remain pay-at-shop; current source rejects `SHOP_COLLECTION_MODE=live`. Do not bypass. |
| Development GCP | `printqs-development` Firebase project, private empty GCS bucket, empty Artifact Registry, VPC/PSA exist. Expensive Cloud SQL and Memorystore dev instances were deleted 2026-09-25 after explicit owner approval. No Cloud Run workload is deployed. | No $50+/month development server should be recreated. Check small usage charges separately. |

## This worktree's verified changes

- PR #25's first commit pinned production Firebase project, Render production environment, and the exact existing production database namespace. A Blueprint regression test passed; all PR checks passed at that original SHA.
- The Blueprint now specifies Resend and private GCS, with secret-backed `RESEND_API_KEY`, `ADMIN_BOOTSTRAP_EMAIL`, and `ADMIN_BOOTSTRAP_PASSWORD_HASH`. `node --test scripts/verify-render-production.test.mjs`: 2/2 pass; `render blueprints validate ./render.yaml`: valid; `git diff --check`: pass. These changes were pushed to PR #25 but are **not merged or deployed**.
- Render's production storage JSON secret file and Resend key were saved with **Save only**; they were not used to deploy the old source.
- This branch now adds a separate platform-admin email recovery flow (15-minute code, per-admin send cap, five-attempt limit, one-time consume, session-version revocation, audit event) and a matching login-page recovery state. It does **not** set or disclose a bootstrap credential, and is not deployed. Verification on 2026-09-26: Prisma generate/validate, API/web typechecks and production builds, API 88/88 tests with `npx vitest run --maxWorkers=2`, web 17/17 tests, focused admin recovery 2/2, token 2/2, and `git diff --check` passed. A first unrestricted API test run overlapped builds and timed out in two unrelated import hooks; the bounded-worker full rerun passed. Database migration execution still needs CI's disposable PostgreSQL and the development deployment.

## Open gates, in priority order

1. Verify Resend DNS/domain status and a real password-recovery email. The domain is pending; do not claim it is verified.
2. Configure a separately authenticated platform admin without disclosing a plaintext password; prove the new admin login/recovery and shop verification against a deployed environment. `ADMIN_BOOTSTRAP_*` values are not yet set in Render. The recovery code exists only on the unmerged PR branch.
3. Confirm Blueprint and out-of-band Render variables/secret file survive sync; run CI on the **new** PR head, merge through PR, and verify Render's exact deployed SHA and startup logs. A failed deploy must not be called live.
4. Run production-safe Firebase/auth, private upload/deletion, queue, pay-at-shop, printer simulator, and email journeys. Real physical printer acceptance is not evidenced.
5. Resolve free production Postgres expiry/no-backup and memory-only queue risk before accepting genuine paid print orders. A successful `/healthz` is insufficient.
6. Complete isolated development deployment and fresh full 100+ case release matrix bound to exact SHA. No such final matrix pass exists yet.
7. Complete Razorpay TEST weekly shop-commission reconciliation, product/use-case approval, and obtain immediate explicit live-money confirmation before any live cutover.

## Rollback and safety

The live Render revision remains `dep-daqjk73l550s73bp7u8g` until a new deploy is independently verified. If a new deploy fails, Render has been serving its prior successful revision; verify this rather than assuming. Revert bad source through a protected feature PR, not a direct `master` push. Database migrations already applied by a failed deploy are **not** automatically rolled back; inspect schema compatibility before any rollback. No production mandate or live debit has been initiated.
