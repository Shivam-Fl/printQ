# Pipeline stalls one stage in: "Workflow initiated by non-human actor"

**Symptom:** a `claude-code-action` step fails immediately with
`Workflow initiated by non-human actor: github-actions (type: Bot)`. It only shows up on the
*second* stage of a dispatch chain — the first stage (human-triggered) works fine.

**Real cause:** `claude-code-action` refuses bot-initiated runs by default, as a guard against
bot loops. Every `.sdlc` stage dispatches the next stage using `GITHUB_TOKEN`, so every run
after the first is, from the action's point of view, started by `github-actions[bot]`. This
never showed up on the framework's own repo because those stages were dispatched by hand
during development — only a real machine-to-machine hand-off exposes it.

**Fix:** each `sdlc-*.yml` workflow sets `allowed_bots: "github-actions"` on its
`claude-code-action` step — scoped deliberately, not `"*"`, since only a workflow *this
pipeline* dispatched should be trusted, not any bot that touches the repo.

**If you add a new `sdlc-*.yml` stage:** it needs this line too, or it will work in manual
testing and die the first time something else in the pipeline dispatches it.

(Fixed in PR #7, 2026-09-16.)
