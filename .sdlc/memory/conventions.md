# Conventions

## Code
- ES modules, Node 22, no transpiler. `.js` for libraries, `.mjs` for executable scripts.
- Pure logic in `scripts/lib/`, IO at the edges. Anything worth testing must be importable
  without a network.
- No dependencies unless a few lines genuinely cannot do it. `js-yaml` is the one exception,
  and it is installed at runtime by `ensure-deps.mjs` (`--no-save`, only if missing) so the
  pipeline works in a host repo with no `package.json` at all. **It must never appear in the
  host repo's own `package.json`/`package-lock.json`** — that happened once from committing a
  local `npm install` wholesale (PR #7) and had to be reverted.
- Shell out to `gh` rather than adding an API SDK.
- `.sdlc/bin/lib/*.js` is the only copy of pipeline logic — a duplicate at `.sdlc/bin/*.js`
  with the same name is a stray, not a second implementation to keep in sync (PR #7).

## Guards fail closed
Every validator, allowlist and parser refuses on input it does not understand. A guard that
silently ignores the unrecognised case reports success for something it never checked — worse
than having no guard, because it is trusted.

## Comments
Explain **why**, never what. A comment restating the code is noise; a comment naming the
failure mode a line prevents is the reason the line survives the next refactor.

## Tests
`node --test`, no framework. Test the failure, not the happy path — the interesting assertions
are the ones that fail when a guard regresses.

## PRs
Conventional commit subject. Body says what changed and why, lists the acceptance criteria,
and names anything deliberately left out of scope.
