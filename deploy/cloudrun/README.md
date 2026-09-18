# PrintQs Cloud Run deployment manifests

These are templates for the isolated **development** environment only. They
are deliberately inert: each `${PRINTQ_*}` value must be rendered by the
manual development deployment workflow after its candidate SHA has passed the
required GitHub checks. No manifest contains a credential, a production
project, or a live Razorpay setting.

## Runtime units

| Unit | Cloud Run resource | Role | Limit |
| --- | --- | --- | --- |
| `printqs-development-api` | Service | Public API and same-origin web bundle | 1–3 instances, 1 vCPU / 1 GiB, 40 concurrent requests |
| `printqs-development-conversion` | Worker pool | File conversion only, including LibreOffice | exactly 1 instance, 2 vCPU / 2 GiB |
| `printqs-development-maintenance` | Worker pool | Timers, deletion, reconciliation, and maintenance schedules | exactly 1 instance, 1 vCPU / 1 GiB |
| `printqs-development-migrate` | Job | Prisma migration before a revision is promoted | one task, no retries |

Cloud Run worker pools are used because they are the Cloud Run resource for
continuous background work; they have no public endpoint or autoscaling. The
conversion pool and maintenance pool consume the same development-only Redis
namespace, but run distinct worker roles. The database remains authoritative
for queue, accounting, and deletion state.

## Required development-only configuration

Before the first render/deploy, create the following in the `development`
GitHub environment; do not place values in a repository file:

- Variables: `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_ARTIFACT_REPOSITORY`,
  `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`, `DEV_S3_ENDPOINT`, and
  `DEV_S3_BUCKET`.
- Secrets: `DEV_DATABASE_URL`, `DEV_REDIS_URL`, `DEV_JWT_SECRET`,
  `DEV_OTP_PEPPER`, `DEV_FIREBASE_API_KEY`, `DEV_FIREBASE_PROJECT_ID`,
  `DEV_S3_ACCESS_KEY_ID`, and `DEV_S3_SECRET_ACCESS_KEY`.

The deployment identity must use GitHub Actions workload identity federation,
not a service-account JSON key. The runtime identity receives only
`Secret Manager Secret Accessor` on the named development secrets. A future
production setup must use a separate GCP project, service account, Artifact
Registry repository, database, Redis, bucket, Firebase project, and GitHub
environment; it must not reuse any resource named here.

## Deployment guardrails

1. Build the image from the candidate SHA, tag it with that immutable SHA, and
   run the Prisma job once.
2. Deploy API with `RUN_WORKERS=false`, then the two worker pools with their
   explicit `WORKER_ROLE` values.
3. Record the Cloud Run revision, image digest, service URL, worker-pool
   revisions, migration execution, and development QA evidence in
   `IMPLEMENTATION_STATUS.md`.
4. Roll back API and both pools to the previously recorded revisions if health
   checks, migration verification, or the integrated development QA fail.

The temporary `https://development.invalid` web origin is replaced with the
actual development Cloud Run URL as part of the manual deployment. It is never
a production origin.
