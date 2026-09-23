# Project

Seeded by `sdlc install` from a scan. **Correct it** — an agent reads this before planning,
and a wrong entry here steers every ticket wrong.

## Stack
node · 279 tracked files

## Top-level layout
- `apps/` — product code: `api`, `web`, `agent`
- `packages/` — shared code (e.g. `shared` for `computePrice`)
- `bin/`, `.sdlc/`, `vibe-to-production-skill/` — pipeline tooling, not product code
- `scripts/` — CI/dev scripts (e.g. `run-ci-tests.mjs`)
- `Dockerfile` (file, not a dir), `docker-compose.yml`, `render.yaml`, `vercel.json` — deploy

## Commands
- typecheck: `npm run typecheck`
- unit: `npm run test`
- build: `npm run build`

## Non-obvious
- `.sdlc/`, `bin/sdlc`, and `vibe-to-production-skill/` are the AI-SDLC pipeline that
  built/reviews this repo — not printQ product code. A ticket about the print-queue product
  touches `apps/` and `packages/`; don't confuse pipeline bugs with product bugs.
- Root `package.json` has no runtime `dependencies` — see [conventions.md](conventions.md) for
  why (`js-yaml` reverted in #7). Don't take a bare npm workspace as license to add one casually.
