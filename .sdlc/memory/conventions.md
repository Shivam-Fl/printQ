# Conventions

## Code
- ES modules, Node 22, no transpiler. `.js` for libraries, `.mjs` for executable scripts.
- Pure logic in `scripts/lib/`, IO at the edges. Anything worth testing must be importable
  without a network.
- No dependencies unless a few lines genuinely cannot do it. Root `package.json` carries
  **no runtime dependencies at all** — `js-yaml` was tried as one and reverted (#7) because it
  polluted the host manifest. `.sdlc/bin/ensure-deps.mjs` installs it lazily at run time
  instead, precisely so the framework never touches a host project's dependency tree.
- Shell out to `gh` rather than adding an API SDK.

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
