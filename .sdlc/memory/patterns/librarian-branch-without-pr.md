# Librarian pushed a memory branch three nights running and never opened the PR

**Symptom:** `git branch -r` shows `memory/2026-09-17`, `memory/2026-09-18`, and
`memory/2026-09-20`, each with a real, non-trivial memory update — but `gh pr list --state all`
has no PR for any of them. Three nights of distilled memory (including the two pattern entries
in this directory) sat on unmerged branches and never reached master until this run folded
them in by hand on 2026-09-21.

**Real cause: confirmed 2026-09-21.** `gh pr create` fails outright for this identity:

```
pull request create failed: GraphQL: GitHub Actions is not permitted to create or
approve pull requests (createPullRequest)
```

`gh auth status` shows the librarian runs as `github-actions[bot]` via the workflow's
`GITHUB_TOKEN`. The repo (or org) setting **"Allow GitHub Actions to create and approve pull
requests"** is off, so every `gh pr create` / GraphQL `createPullRequest` call from this token
is rejected — not a transient failure, not something a retry fixes. `.sdlc/bin/lib/` has no
fallback for this (no PAT, no `peter-evans/create-pull-request`-style action step), so the
workflow's only path to opening a PR is exactly the call that is blocked. Three straight runs
pushed a commit (`git push` uses the same token and is *not* blocked by this setting) and then
silently lost the PR step.

**This is a repo-admin setting, not something the agent can fix.** Flip it at
Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and
approve pull requests", or give the librarian job a PAT/app token with PR-creation rights
instead of the default `GITHUB_TOKEN`.

**Mitigation until that's fixed:** before writing anything else, check for orphaned memory
branches and fold in whatever is still valid instead of starting fresh —
`git branch -r | grep '^  origin/memory/'` and diff each against master. After pushing this
run's branch, attempt `gh pr create` and check its exit code — if it fails with the message
above, say so explicitly in the run's final report (branch pushed, PR blocked, here's the
compare URL) instead of ending silently as if the job succeeded.

(Discovered 2026-09-21: attempting to open this very PR hit the error above.)
