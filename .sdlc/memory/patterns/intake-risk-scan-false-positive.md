# Intake risk-scanner flags issues for their own "out of scope" text

**Symptom:** an issue that explicitly says `Explicitly out of scope: pricing, payment, refunds`
gets stopped by intake for touching payments — the opposite of what the sentence says.

**Real cause:** the risk scanner (`.sdlc/bin/lib/triage.js`, `riskAreas`) did keyword matching
over the whole issue body. A section describing what will *not* be done, or a notes/background
section quoting a past migration or config key by name, matches the same keywords as a section
describing what *will* be done.

**Fix:** `strippedForRisk()` removes headed sections whose heading matches out-of-scope /
non-goals / "explicitly excluded" / notes / background / prior-art before the keyword scan
runs. The title is never stripped — a risky change can't be hidden under such a heading.
Applies to any future keyword-based gate over free-form issue/PR text in this repo: strip
declared-negative sections before scanning, always scan the title.

**Related, same PR:** re-running intake on an issue already in `needs-human` failed with
`illegal transition needs-human -> needs-human`. `lib/ledger.js` now treats landing on the
state already held as a no-op instead of an illegal transition — a retry or a replayed
workflow is ordinary, not an error. Worth checking if you add a new state-machine transition
anywhere in `.sdlc/`: does it tolerate being re-run in the state it's already in?

(Fixed in PR #5, 2026-09-16.)
