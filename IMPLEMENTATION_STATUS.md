# PrintQs launch implementation status

Last updated: 2026-09-15 (Asia/Kolkata)

## Current phase

Phase 0 — baseline frozen; Phase 1 CI/release implementation in progress.

## Ownership and branch

| Item | Value |
| --- | --- |
| Integration owner | Codex lead implementation agent |
| Isolated worktree | `C:\Users\acer\Desktop\startup\printQ-ci-release` |
| Feature branch | `codex/ci-release-baseline` |
| Baseline commit | `18c89ef62bbf73a2128028f2f62a4a96a08cf477` |
| Production branch at audit | `master` at the same SHA |
| New release branches | `development` and `main`, both created from the frozen baseline |

## Baseline evidence

- Source working tree was deliberately left untouched. It contains user-owned modified and untracked QA/generated materials.
- The isolated worktree starts clean from the audited deployed SHA above.
- Existing QA workbook: `outputs/printqs-production-qa-20260915/PrintQs_Production_QA_Matrix.xlsx`; 164 cases, 147 pass, 17 externally/device/provider-blocked at the historical run, and one open launch-hygiene defect (`DEF-010`, QA shops publicly discoverable).
- Current CI workflow has Node 22 but does not provision PostgreSQL or Redis and runs no Prisma migration/integration environment. This is the first defect to repair.
- Existing deployment configuration is Render/free/local storage, combined API/worker, console reset email, and legacy student Razorpay/Route paths. These are historical and are not production-launch compliant.

## Environment and provider status

| Area | Audited state | Launch status |
| --- | --- | --- |
| Development | No isolated branch-scoped environment evidenced | Not created |
| Production compute | Render combined API/worker configuration | Must move to Cloud Run |
| File storage | Local/ephemeral configuration | Must replace with private durable object storage |
| Student checkout | Online Razorpay plus cash legacy options | Must become pay-at-shop only |
| Shop collection | Route payout/mock balance payment legacy path | Must become receivable + weekly recurring collection |
| Razorpay UPI AutoPay | Account approval not evidenced; stated unavailable | External approval required before test/live mandate |
| Resend domain | Verification not evidenced | External DNS/account action required |
| Physical printer | Simulator evidence only | Physical acceptance required |

## Tests and evidence

| Command / evidence | Result | Notes |
| --- | --- | --- |
| Historical `npm test` / typecheck / build | Historical pass only | Must be re-run in the isolated environment |
| Historical production matrix | 147 pass / 17 blocked | Not valid for the new architecture |
| `npm run typecheck` | Passed | All workspaces after CI/test teardown changes |
| `npm run test` | Passed | 88 tests: 44 shared, 29 API, 15 web |
| `npm run test:ci` | Passed | 88 tests and JUnit reports for shared/API/web workspaces |
| `npm run build` | Passed | All packages; existing web bundle-size warning remains tracked |
| `npm audit --omit=dev --audit-level=high` | Passed | 0 reported production dependency vulnerabilities |
| Local Docker integration run | Deferred | Docker Desktop engine failed locally; no user-owned services were used. GitHub Actions supplies isolated PostgreSQL/Redis for the required migration and simulator run. |
| CI run `35005552170` | Cancelled | CI simulator configuration defect: it defaulted to Redis `6380` while the disposable service is `6379`; no result from this run is accepted as launch evidence. |

## Rollback

- Code rollback target is the immutable baseline commit `18c89ef62bbf73a2128028f2f62a4a96a08cf477`.
- No deployment, migration, provider configuration, or live-money action has been performed by this implementation stream.

## Next action

Push the CI repair as a feature branch PR to `development`, verify GitHub's disposable PostgreSQL/Redis migration and simulator run, then protect `development` and `main` with the observed required checks.
