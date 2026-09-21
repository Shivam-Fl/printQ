# Librarian pushed a memory branch three nights running and never opened the PR

**Symptom:** `git branch -r` shows `memory/2026-09-17`, `memory/2026-09-18`, and
`memory/2026-09-20`, each with a real, non-trivial memory update — but `gh pr list --state all`
has no PR for any of them. Three nights of distilled memory (including the two pattern entries
in this directory) sat on unmerged branches and never reached master until this run folded
them in by hand on 2026-09-21.

**Real cause: unconfirmed.** `.github/workflows/sdlc-librarian.yml` has no explicit
`gh pr create` step — the prompt tells the agent to "Open ONE PR", so PR creation is something
the agent must actually execute, not something the workflow does for it. Each prior run
produced a commit and a pushed branch (so `git push` ran) but apparently stopped before, or
failed silently during, `gh pr create`. There's no run log retained to confirm which.

**Mitigation:** before writing anything else, check for orphaned memory branches and fold in
whatever is still valid instead of starting fresh — `git branch -r | grep '^  origin/memory/'`
and diff each against master. After committing this run's update, verify the PR actually
exists (`gh pr list --search "memory:" --state open` or check the URL `gh pr create` prints)
before finishing — don't trust that the shell command ran just because no error was printed to
a log nobody reads.

(Discovered 2026-09-21, during a routine memory run — no new merged PRs that night, so the
audit went into memory-branch hygiene instead.)
