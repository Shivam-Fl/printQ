# Project

Seeded by `sdlc install` from a scan. **Correct it** — an agent reads this before planning,
and a wrong entry here steers every ticket wrong.

## Stack
node · 279 tracked files

## Top-level layout
- `Dockerfile/`
- `apps/`
- `bin/`
- `packages/`
- `scripts/`
- `vibe-to-production-skill/`

## Commands
- typecheck: `npm run typecheck`
- unit: `npm run test`
- build: `npm run build`

## Non-obvious
- `apps/api/src/test/setup.ts` defaults `DATABASE_URL`/`REDIS_URL` to the **standard** ports
  (`5432`, `6379`), not the dev-compose ports from `docker compose up` (`15432`, `6380`) named
  in `CLAUDE.md`. CI provisions disposable Postgres/Redis on the standard ports for exactly
  that reason. Running `npm run test` locally against your usual `docker compose up -d postgres
  redis` will silently target the wrong port unless you export `DATABASE_URL`/`REDIS_URL`
  yourself first.

Add what a newcomer gets wrong: which module owns what, the abstraction that looks
redundant but is not, the test that is slow for a reason, the service that must be running
locally. The Librarian appends here as the system learns, but it starts from what you write.
