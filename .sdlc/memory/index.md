# Memory index

One line per entry, describing **when it applies** — an agent reads this before deciding
whether to open the entry itself.

## Always
- [project.md](project.md) — stack, layout, commands. Read before any planning.
- [conventions.md](conventions.md) — naming, errors, tests, PR style for `.sdlc/` pipeline
  tooling only. Writing printQ app code (`apps/`, `packages/`)? Use root `CLAUDE.md` instead.

## Situational
- [qa/environment.md](qa/environment.md) — env quirks and login recipes. Read before browser QA.
- [qa/selectors.md](qa/selectors.md) — selectors known to be stable. Empty for now — no
  printQ-specific selectors have been confirmed by a QA run yet.
- [patterns/pipeline-bot-dispatch-blocked.md](patterns/pipeline-bot-dispatch-blocked.md) — a new
  `sdlc-*.yml` stage dies with "non-human actor" the first time another stage dispatches it.
- [patterns/intake-risk-scan-false-positive.md](patterns/intake-risk-scan-false-positive.md) —
  extending the intake risk scanner or any keyword gate over issue/PR text; also covers
  re-running a stage that lands back on its current state.
- [patterns/librarian-branch-without-pr.md](patterns/librarian-branch-without-pr.md) — read this
  one at the *start* of every librarian run: check **all** orphaned `memory/*` branches (not
  just the newest) before writing anything new, verify each claim against current code, and
  confirm the PR actually opened before finishing.
- [decisions/](decisions/) — why things are as they are. Read before proposing a rewrite. Empty
  so far — no ADR-worthy decision has been recorded yet.
