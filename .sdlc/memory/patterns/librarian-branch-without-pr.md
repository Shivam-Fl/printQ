# Librarian pushed a memory branch and never opened the PR — and a later run lost the work

**Symptom:** `git branch -r` shows a `memory/YYYY-MM-DD` branch with a real, non-trivial memory
update, but `gh pr list --state all` has no PR for it. Master never receives the update.

**Real cause: confirmed 2026-09-21, still true 2026-09-23.** `gh pr create` fails outright for
this identity:

```
pull request create failed: GraphQL: GitHub Actions is not permitted to create or
approve pull requests (createPullRequest)
```

`gh auth status` shows the librarian runs as `github-actions[bot]` via the workflow's
`GITHUB_TOKEN`. The repo (or org) setting **"Allow GitHub Actions to create and approve pull
requests"** is off, so every `gh pr create` / GraphQL `createPullRequest` call from this token
is rejected — not transient, not something a retry or a `pull-requests: write` permission line
in the workflow YAML fixes (`sdlc-librarian.yml` already grants that; it doesn't matter,
because the block is a repo/org policy, not a token-scope problem). `git push` uses the same
token and is **not** blocked by this setting, so the branch always lands even though the PR
never does.

**This is a repo-admin setting, not something the agent can fix.** Flip it at
Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and
approve pull requests", or give the librarian job a PAT/app token with PR-creation rights
instead of the default `GITHUB_TOKEN`.

## Second failure mode this caused: a night's memory silently regressed

The 2026-09-17 through 2026-09-21 runs each branched from **master**, which never advances
(no memory PR has ever merged), and by 2026-09-21 that branch carried four nights of real,
verified content: `conventions.md` and `project.md` rewritten with correct scope and layout,
three `patterns/*.md` entries, and `qa/selectors.md` emptied of a stale demo-app selector list.

The 2026-09-22 run also branched from master — not from `memory/2026-09-21` — so it never saw
any of that. It re-discovered independently that `qa/selectors.md` held stale selectors,
deleted the file outright (losing the placeholder note too), and reported "no PRs merged, no
issues closed" as if the run before it had never happened. Four nights of distilled memory
existed only on an unmerged branch and one line away from being paved over by the next run
that didn't know to look for it. This run (2026-09-23) recovered it by diffing every
`origin/memory/*` branch against master, verifying each claim against current code (grep for
the referenced function/config, not just trusting the prose), and folding in whatever still
held — see this run's PR body for what was verified and what changed.

**Mitigation, now a hard requirement, not a suggestion:**
1. Before writing anything else: `git branch -r | grep '^  origin/memory/'`. For **every** one
   (not just the newest), `git diff master origin/memory/<date>` — do not skip a branch because
   a newer one exists, since the newest run may itself have branched from master and missed
   what an older one had.
2. Verify, don't trust: for each claim in an orphaned branch, grep the current repo for the
   file/function/config it names. Only fold in what still checks out; note in the PR body
   anything that no longer applied and why.
3. Branch this run from the branch with the most recent *content*, not from master, once step 1
   shows master is behind.
4. After pushing, attempt `gh pr create` and check its exit code. If it fails with the message
   above, say so explicitly in the run's final report (branch pushed, PR blocked, here's the
   compare URL) instead of ending silently as if the job succeeded.

(Root cause discovered 2026-09-21. Second occurrence — a run skipping step 1 of its own
mitigation — discovered and fixed 2026-09-23.)
