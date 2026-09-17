# Memory index

One line per entry, describing **when it applies** — an agent reads this before deciding
whether to open the entry itself.

## Always
- [project.md](project.md) — stack, layout, commands. Read before any planning.
- [conventions.md](conventions.md) — naming, errors, tests, PR style. Read before writing code.

## Situational
- [qa/environment.md](qa/environment.md) — env quirks and login recipes. Read before browser QA.
- [patterns/pipeline-bot-dispatch-blocked.md](patterns/pipeline-bot-dispatch-blocked.md) — a new
  `sdlc-*.yml` stage dies with "non-human actor" the first time another stage dispatches it.
- [patterns/intake-risk-scan-false-positive.md](patterns/intake-risk-scan-false-positive.md) —
  extending the intake risk scanner or any keyword gate over issue/PR text; also covers
  re-running a stage that lands back on its current state.
- [decisions/](decisions/) — why things are as they are. Read before proposing a rewrite.

_No `qa/selectors.md` yet: the one seeded at install was a generic todo-app template that
doesn't match printQ's UI (deleted 2026-09-17). Next QA browser run should populate this with
real printQ selectors._
