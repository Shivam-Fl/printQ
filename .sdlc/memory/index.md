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
- [patterns/](patterns/) — bug shapes this repo has produced before. Grep by symptom.
- [decisions/](decisions/) — why things are as they are. Read before proposing a rewrite.
