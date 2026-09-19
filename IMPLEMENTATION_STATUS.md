# PrintQs launch implementation status

Last updated: 2026-09-19 (Asia/Kolkata)

## Current phase

Phase 0 is frozen and Phase 1 CI/release controls are implemented and evidenced. Phase 2 isolation is partially complete: a distinct Firebase development project and GitHub development environment exist, while durable development database, queue, object storage, Cloud Run, Resend, and Razorpay TEST endpoints still require their own provider resources. The verified-print retention candidate in PR #9 has its exact required-check evidence; the active stacked branch adds code-enforced environment namespaces and provider-mode guardrails before any development deployment is permitted. A separate, unmerged Cloud Run branch now supplies an API service, isolated conversion/maintenance worker-pool templates, an explicit migration job, and a manual SHA-guarded development deployment workflow. The active storage branch replaces the development S3/R2 configuration with private native GCS via Cloud Run application-default credentials. The Firebase candidates now add server-verified App Check, PostgreSQL-transactional minimal queue projections, and a leased/idempotent FCM notification-delivery outbox. The active Resend candidate removes reset-code logging, makes console email invalid in production, and records redacted delivery evidence with persistent per-email limits. Firebase remains rebuildable delivery/realtime infrastructure, never an order, queue, or financial authority. None has been deployed.

## Ownership and release source

| Item | Value |
| --- | --- |
| Integration owner | Codex lead implementation agent |
| User-owned source tree | `C:\Users\acer\Desktop\startup\printQ` — deliberately untouched; it contains QA/generated changes |
| Isolated implementation worktree | `C:\Users\acer\Desktop\startup\printQ-phase2-master` |
| Verified retention branch / PR | `codex/storage-completion-retention` / [PR #9](https://github.com/Shivam-Fl/printQ/pull/9) |
| Required-check retention SHA | `2be8a674a8a1ebca333d6d6fc5e994dfa1b20ee9` |
| Active stacked isolation branch / PR | `codex/environment-isolation` / [PR #10](https://github.com/Shivam-Fl/printQ/pull/10) (code fix `9ef164e`; stacked on the retention candidate and not mergeable until its prerequisite and a development deployment path are verified) |
| Active Cloud Run runtime branch / PR | `codex/cloud-run-runtime` / [PR #12](https://github.com/Shivam-Fl/printQ/pull/12) (based on the isolation candidate; unmerged and undeployed) |
| Active GCS storage branch / PR | `codex/gcs-storage-runtime` / [PR #13](https://github.com/Shivam-Fl/printQ/pull/13) (stacked on the Cloud Run candidate; unmerged and undeployed) |
| Active App Check branch / PR | `codex/firebase-projections` / [PR #14](https://github.com/Shivam-Fl/printQ/pull/14) (stacked on the GCS candidate; unmerged and undeployed) |
| Active Firebase outbox branch / PR | `codex/firebase-outbox` / [PR #15](https://github.com/Shivam-Fl/printQ/pull/15) (stacked on the App Check candidate; unmerged and undeployed) |
| Active FCM branch / PR | `codex/fcm-notifications` / [PR #16](https://github.com/Shivam-Fl/printQ/pull/16) (stacked on the Firebase outbox candidate; unmerged and undeployed) |
| Active Resend branch / PR | `codex/resend-password-recovery` / PR pending (stacked on the FCM candidate; unmerged and undeployed) |
| Current release source | `master` (user-directed; `main` remains protected but is not a release path) |
| Frozen deployed baseline | `18c89ef62bbf73a2128028f2f62a4a96a08cf477` |
| Current audited master base | `dd2c94bd0db444a634abc1f30eba10a98cd61731` |

## Completed, evidenced controls

- The historical deployed SHA was recorded before implementation. The original working tree and its user-owned QA files were preserved.
- CI now provisions disposable PostgreSQL 16 and Redis 7, verifies connectivity, applies Prisma migrations, builds all workspaces, runs the full test suite and agent simulator, retains JUnit/simulator evidence, checks production dependencies, and scans secrets.
- GitHub Actions run `35124027115` passed for the current audited `master` base. The earlier CI repair passed in run `35006008738`; cancelled runs are not accepted as evidence.
- `master`, `development`, and the unused `main` are protected with pull requests and required `CI / check` plus `CI / secret scan`; direct, content-identical push probes to `master` and `development` were rejected by GitHub (`GH006`).
- A separate Firebase development project was created in the Firebase console with Analytics/Gemini disabled and a registered development web application. Six development-only browser configuration values are stored as GitHub **development environment** secrets; no values are in Git.
- Docker Desktop remains unavailable on this workstation. No Docker Desktop repair or user-service mutation was attempted. Local validation uses pure/unit/build checks and GitHub Actions supplies disposable PostgreSQL/Redis integration services.

## Active retention change (awaiting CI/PR)

- A Windows spool acknowledgement is now recorded separately and cannot mark an order printed, post earnings, notify pickup, or start deletion.
- Deterministic simulator completion is permitted only when explicitly enabled outside production. Real jobs remain visibly awaiting an authenticated staff member's **Printed successfully** confirmation.
- PostgreSQL records the print confirmation method/time, deletion schedule, deletion attempts/error, and deletion completion. The confirmed successful print or terminal cancellation/expiry creates a fixed T+10-minute deadline; an earlier deadline can never be extended by retries.
- A delayed deletion job targets each exact deadline; a one-minute PostgreSQL-backed sweeper reconciles missed schedules and a retry-exhausted job lands in a content-free dead-letter queue. Deletion removes every source/converted/preview object, scrubs stored filename/source metadata, and retains only non-content audit/order metadata. Outages/overdue recoverable jobs are recorded instead of silently extending retention.
- The simulator/E2E contract has been updated to declare deterministic completion explicitly. The real Windows agent reports only `spool_accepted` and removes its temporary cache in its existing `finally` block.

## Tests and evidence

| Command / evidence | Result | Notes |
| --- | --- | --- |
| `npm run db:generate -w apps/api` | Passed | Prisma client regenerated from the active schema. |
| `npx prisma validate --schema apps/api/prisma/schema.prisma` | Passed | Executed with an isolated disposable test connection string. |
| `npm run typecheck -w apps/api` | Passed | After the retention/confirmation change. |
| `npm run test -w apps/api` | Passed | 13 files / 33 tests; includes strict deadline and object-deletion-manifest regression coverage. |
| `npm run build -w apps/web` | Passed | Existing bundle-size warning remains; no failure. |
| `npm run test:ci` | Passed | Shared, API, and web JUnit reports written under `.tmp/ci-results/`. |
| Full local migration/E2E | Deferred safely | Requires PostgreSQL/Redis; GitHub CI will run the disposable migration and simulator path. Docker Desktop is not used as a workaround. |
| GitHub Actions `35131596603` | Passed | Exact candidate migration deploy/status, build, typecheck, JUnit suite, full print-agent simulator, dependency audit, and CI artifact upload. |
| GitHub Actions `35131203760` | Rejected | Simulator correctly caught the initial premature legacy earning credit. Commit `2b2c630` moves the credit to verified physical print status and the full rerun above passes. |
| User-owned SDLC `qa` `35131698781` | Not a release gate; failed | Its validation expects `qa-report.json`, but its own workflow did not produce one for this master-targeted PR. `gh pr checks --required` confirms only `CI / check` and `CI / secret scan`, both passed. The workflow is preserved unchanged. |
| Isolation branch local suite | Passed | API 16 files / 40 tests, all-workspace typecheck, web production build, root JUnit suite with zero failures/errors, and Prisma schema validation. |
| PR #10 CI regression reproduction | Passed locally and in CI | GitHub run `35133141729` correctly caught a test that hard-coded `printq-test` while the CI environment uses `printq-ci-test`; the assertion now derives `QUEUE_NAMESPACE`. The affected test and API suite (16 files / 40 tests) pass under the exact CI namespace, followed by API typecheck and the GitHub rerun below. |
| GitHub Actions `35347722899` | Passed | Required CI and secret scan passed for `9ef164e`: disposable PostgreSQL/Redis readiness, Prisma deploy/status, all builds/typechecks, JUnit suite, agent simulator, dependency audit, and retained artifacts. The user-owned non-required `qa` workflow failed again because its workflow expects an artifact it does not create; it was not modified. |
| Cloud Run runtime branch local suite | Passed | API role contract: 17 files / 42 tests; API and all-workspace typechecks; API production build; root JUnit reports with zero failures/errors. Cloud Run API/worker/job templates rendered with dummy development-only values and passed YAML structural validation. No Docker Desktop use or cloud deployment occurred. |
| GitHub Actions `35350351902` | Passed | Required `CI / check` and `CI / secret scan` passed for Cloud Run candidate code `3440790`: disposable PostgreSQL/Redis readiness, Prisma deploy/status, full build/typecheck/JUnit suite, agent simulator, dependency audit, and retained artifacts. The user-owned non-required `qa` workflow failed for its known missing `qa-report.json` artifact and remains unchanged. |
| GCS storage branch local suite | Passed | GCS namespace/save/download/delete/V4 signed-preview regressions and environment-isolation tests: 18 API files / 46 tests. All-workspace typecheck, root JUnit suite, and web production build passed. All four manifests rendered with dummy development-only values and passed YAML structural validation. Runtime production-dependency audit has no high findings; the Google client dependency transitively retains two moderate `uuid` findings, recorded for dependency follow-up rather than auto-upgrading. |
| App Check branch local suite | Passed | App Check monitor/enforce policy and invalid-project regressions: API 13 focused tests plus web API 5 focused tests. All-workspace typecheck, root JUnit suite, API build, and web production build passed. App Check uses the Firebase Admin SDK with application-default credentials and sends assertions only in the `X-Firebase-AppCheck` header. Runtime production-dependency audit has no high findings; two transitive moderate `uuid` findings remain recorded for follow-up. |
| Firebase transactional-outbox local suite | Passed | 20 focused tests and the complete API suite (21 files / 57 tests) cover atomic transition/audit/outbox creation, Firebase UID identity binding, scoped projection paths, automatic position refresh for every active shop-queue job, and no-document/no-location/no-phone/no-money payloads. Prisma generation/validation, all-workspace typecheck, root JUnit suite, API and web builds passed. The runtime production-dependency audit has no high findings; the existing two transitive moderate `uuid` findings remain recorded for dependency follow-up. |
| FCM notification-outbox local suite | Passed | FCM registration, privacy-minimal payload, invalid-token pruning, durable event-key de-duplication, lease contention, and retry-release regressions pass. Full API (23 files / 63 tests), web (3 files / 15 tests), all-workspace typecheck, root JUnit suite, Prisma generation/validation, and API/web production builds pass. The registry audit endpoint returned HTTP 503 twice on 2026-09-19; the last successful production audit had no high findings and the same two recorded transitive moderate `uuid` findings. |
| Resend reset-recovery local suite | Passed | Resend request authentication, redacted provider-error handling, delivery-id-only audit data, persistent per-email limits, and production console-provider rejection regressions pass. Full API (24 files / 66 tests), web (3 files / 15 tests), all-workspace typecheck, root JUnit suite, Prisma generation/validation, and API/web production builds pass. The npm advisory endpoint remained unavailable (HTTP 503); no audit result is claimed for this rerun. |

## Environment/provider status and blockers

| Area | Current status | Required next action / owner |
| --- | --- | --- |
| Development Firebase | Isolated project and GitHub environment secrets created | Enable Auth/App Check/realtime/FCM after application wiring; use only development configuration. |
| Development PostgreSQL/Redis/GCS | Not yet provisioned | Development Cloud Run Admin API was rechecked enabled on 2026-09-19; the development project contains no Cloud Run services, jobs, or worker pools. Create distinct durable resources, a private GCS bucket with uniform bucket-level access and public access prevention, Artifact Registry, runtime/deploy identities, workload identity federation, and an isolated Redis namespace; do not create or reuse production resources. |
| Production compute/storage | Render combined/local-storage configuration remains legacy | Do not use for real orders; Cloud Run + separate workers + private object storage remain required. |
| Historical secret scan | Full-history scan detects an old Firebase browser key in Git history | Coordinate key restriction/rotation before history remediation; do not expose its value. |
| Razorpay AutoPay | UPI AutoPay approval is not evidenced and must remain unclaimed | Founder must authorize an accurate enablement request; no mandate/debit is permitted. |
| Resend | Domain verification not evidenced | Founder/DNS owner must verify a sender domain. |
| Physical printer | Simulator only | Shop owner must complete and document real Windows printer acceptance before advertising capabilities. |

## Rollback

- Before this active branch is merged: close its PR; `master` stays at `dd2c94bd0db444a634abc1f30eba10a98cd61731`.
- After a future merge but before deployment: revert the exact merge commit through a protected feature PR; do not rewrite shared history.
- No Cloud Run, database, storage, Firebase Auth, Razorpay, Resend, production deployment, live key, mandate, or real-money action has been performed by this stream.

## Next action

The Google Cloud billing administrator must complete Google’s account-verification flow. Then provision only the approved development resources, store no credential in Git, and run the SHA-guarded development deployment workflow against the required-check-passing stacked candidate. Validate that deployment end-to-end before merging its PR into `master`; do not let the legacy Render deployment become a substitute for the isolated Cloud Run gate.
