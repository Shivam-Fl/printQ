# PrintQs baseline, CI gate, and development isolation audit — 2026-09-26 IST

This is sanitized release evidence. No environment values, database rows, credentials, backup content, or browser session material are stored here. The owner-selected production branch is `master`; `main` is unused.

## Phase 0 — deployed baseline

| Check | Verified result |
| --- | --- |
| `git ls-remote origin refs/heads/master refs/heads/development` | Baseline: `master=ff9f99fd2d2e28438fdc531875766c192026e359`; `development=7161ff8ef484a911de30702623ca617ffdb5e5cf` (three commits behind). After protected sync PR #26 merged, `development=af130510252f9888b7bddbbbf01915c47b6ddf9c`; `master` is unchanged. |
| `render services --output json`, filtered to PrintQ | `printq-web` (`srv-dafems740ujc73b080e0`), free web, linked to `master`; no development Render web service in this workspace. |
| `render deploys list srv-dafems740ujc73b080e0 --output json` | Live `dep-daqjk73l550s73bp7u8g` at `d9319e858e98f2d60160b761402f6c10ea0eae25`. Deploy `dep-dar65rrncjis73c9iibg` of current master `ff9f99f` failed; it is not live. The live deploy ID is the current application rollback target. |
| `render postgres list --output json` | Production `printq-db`, free, available, Oregon, expiry **2026-10-07**. Free plan has no managed backups. |
| `render keyvalues list --output json` | Production `printq-redis`, free, available, Oregon; free mode is memory-only. |
| Read-only production SQL via Render CLI | 28 finished Prisma migrations; 12 shops (all `draft`, none published), 0 active canonical campuses, 8 student records, 83 job records. No row-level personal data was copied into evidence. |
| Public smoke | `https://api.printqs.com/healthz` HTTP 200, `https://printqs.com` HTTP 200. **Live public shop API returned all 12 draft/unpublished shops**, 8 with obvious test/demo/QA slugs, all shown offline. This is a launch-blocking discovery defect in the old live revision; the newer source's verified-only filter is not deployed. |
| Production database backup | A PostgreSQL custom-format baseline dump was written **outside the repository** under the current user's local AppData `PrintQ/backups` directory. File `printq-production-baseline-20260926-013159.dump`, 130,241 bytes, SHA-256 `0B839A9BCB09E2A86A8EAA0D9F176CAAB34777F44E688DC8AC4C8CE87EEC1DFE`; `pg_restore --list` passed. File ACL allows only the Windows owner, SYSTEM, and Administrators. A full restore rehearsal has not yet been run. This single local dump is not managed backup/PITR or an offsite durability solution. |

The external Chrome browser showed an authenticated Render Dashboard, but service-page inspection repeatedly timed out. The authenticated Render CLI was then used for authoritative service/deploy/datastore reads. Browser failures are not evidence of account failure. No secrets were displayed or exported.

## Phase 1 — CI and production deploy gating

- GitHub `master`, `development`, and unused `main` have required `CI / check` and `CI / secret scan`, PR enforcement, admin enforcement, no force push, and no deletion. Earlier direct-push probes were rejected (`GH006`), per the existing release history. There is no required independent PR review.
- Three consecutive CI runs on PR #25 passed at code SHAs `5e9cdbf`, `93037ca`, and `eac8639`. The latest included 29 fresh local migrations, 168 package tests, 93 simulator assertions, build, typecheck, dependency audit and secret scan. [Local QA evidence](../printqs-local-qa-20260926/LOCAL_QA_STATUS.md) has details.
- Protected sync [PR #26](https://github.com/Shivam-Fl/printQ/pull/26) merged `master` history into `development` only after its CI, secret scan, gate, and verification checks passed. Integration [PR #25](https://github.com/Shivam-Fl/printQ/pull/25) subsequently merged into `development` after all final-head checks passed. Neither merge changed `master` or deployed Render production.
- PR #25 added a required-CI release-source guard: `master` PRs from branches other than protected `development` fail when this workflow is in the PR merge tree; feature PRs into `development` and push CI continue. The guard was first reproduced as three failing regression tests, then passed all three tests plus adjacent Blueprint/Compose tests and all-workspace typecheck locally. PR #25's final-head checks and post-merge `development` push CI passed at `23a85865414ad8aa38be704e075aff5168cb2c51` ([run](https://github.com/Shivam-Fl/printQ/actions/runs/36185663896)). The guard is **not yet on `master`**, so old-branch PRs targeting master are not fully blocked by it; this is not a QA-evidence gate.
- Live Render configuration was found at `autoDeployTrigger=commit`, meaning GitHub required checks did **not** gate its deployment attempts. It was changed via authenticated Render CLI to `autoDeployTrigger=off` / `autoDeploy=no`. The current service now requires an explicit commit-ID deployment. The latest deploy history remained unchanged immediately after this setting change; no new code was deployed. `render.yaml` now mirrors the manual exact-SHA policy, with a regression test and successful Render Blueprint validation.
- Phase 1 is **not fully complete**: the release-source guard is not yet on `master`, and a hosted development deployment plus exact-SHA QA-evidence gate are missing. Do not infer them from green PR checks.

## Phase 2 — isolated development

- Existing `printqs-development` Firebase project, development-only private GCS bucket, empty Artifact Registry, and dedicated network are documented in the release log. Expensive development Cloud SQL/Memorystore instances were previously removed with owner approval and were not recreated.
- GitHub's `development` environment has project/region/registry/network/bucket variable names and six Firebase browser-configuration secret names. It lacks the deployed workflow's WIF provider, deploy service account, Cloud SQL, and Redis settings. No hosted development API/worker is running. The Docker PostgreSQL/Redis used for local QA is isolated and was stopped afterward; it is **not** a hosted development deployment.
- The currently signed-in Render workspace already uses its single allowed free PostgreSQL and single allowed free Key Value instance for the production-named resources. [Render's free-tier limits](https://render.com/docs/free) prevent adding a second free DB/KV in this same workspace. No paid development service was purchased or created.
- `render workspaces --output json` showed only one accessible workspace for this account; there is no existing separate Render workspace to hold another free datastore pair.
- Phase 2 is **not complete**: hosted dev services, environment-scoped server credentials, and live cross-environment tests remain open. Never point development at the existing production database, Redis, bucket, Firebase users, or secrets to make a deployment appear green.

## Exact next release gates

1. Fix the live public discovery exposure by deploying a verified candidate that filters draft/unpublished shops; first satisfy the candidate's production startup configuration and development QA. Do not claim it fixed based on source code alone.
2. Stand up a genuinely isolated, free/near-zero-cost development runtime/datastore path. The current Render workspace cannot host a second free PG/KV; do not buy $50+ dev infrastructure or share production state.
3. Run the clean development browser/provider/storage QA matrix and confirm exact SHA. Production must remain on explicit commit-ID deploys; never deploy a failed check or silently enable live shop debits.
