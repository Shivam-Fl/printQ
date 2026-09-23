# Conventions

**Scope: the `.sdlc/` pipeline's own tooling** (`.sdlc/bin/`, `scripts/`) — not the printQ
product code. `apps/` and `packages/` are TypeScript on Express/Prisma/React/Vitest with
plenty of dependencies; their conventions live in the root `CLAUDE.md`, not here.

## Code
- ES modules, Node 22, no transpiler. `.js` for libraries, `.mjs` for executable scripts.
- Pure logic in `scripts/lib/`, IO at the edges. Anything worth testing must be importable
  without a network.
- No dependencies unless a few lines genuinely cannot do it. Root `package.json` carries no
  runtime `dependencies` at all — `js-yaml` is the one exception, and `.sdlc/bin/ensure-deps.mjs`
  installs it lazily at run time (`--no-save`, only if missing) precisely so the pipeline never
  touches a host repo's own manifest. It got committed into the host `package.json` wholesale
  once, by mistake, and had to be reverted (PR #7) — don't repeat that by running a plain
  `npm install` and committing the result in a checkout that has `.sdlc/` vendored in.
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
