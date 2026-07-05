---
name: vibe-to-production
description: Use this skill whenever a user wants to take an AI-generated, vibe-coded, prototyped, or MVP web or mobile app and make it production-ready, secure, or scalable. Trigger on "make this production ready," "is my app secure," "harden this app," "audit my codebase," "prepare for launch," "scale this," "safe to deploy," or any request to review/fix a Lovable, Bolt, Replit, v0, Cursor, Windsurf, or Claude-generated app before real users touch it. Also trigger proactively when a user asks to deploy or ship a prototype. Covers security hardening (auth, injection, secrets, access control, IDOR), database scalability, mobile concerns (Keychain/Keystore, certificate pinning, app store review), observability, and AI-generated technical-debt remediation. Not for greenfield generation — only for hardening code that already exists.
---

# Vibe-to-Production

## Why this skill exists

AI coding tools are very good at producing code that *works* and very bad at producing code that's *safe at scale*, because "make the login page" rarely comes with "...and rate-limit it, hash the password correctly, and don't trust the client." The functionality is usually fine. What's missing is everything nobody asked for out loud: row-level access control, parameterized queries, secrets that live outside the repo, indexes on the columns actually being queried, and a plan for what happens when 50 people hit the same endpoint at once.

This is not a hypothetical problem. Independent audits of thousands of AI-generated apps consistently find the same five or six critical issues — missing auth checks, secrets shipped to the client, IDOR (one user reading another user's data by changing an ID in a URL), wide-open CORS, and SQL built from string concatenation — and these are the issues that actually take real products down, not exotic zero-days. The fix isn't a rewrite. It's a structured pass that finds what's missing and closes it, in priority order, without breaking what already works.

**The job here is forensic, not generative.** Read the actual code before proposing anything. Don't apply a generic checklist from memory — verify each item against what's actually in the repo, because a vibe-coded app's stack and shape vary wildly and half of any generic checklist won't apply.

## Workflow

### Step 1: Establish scope before touching code

Don't start grepping yet. A few minutes of orientation prevents wasted work and a checklist applied to the wrong stack.

Determine, by reading the repo (`view` the directory tree, check `package.json` / `pubspec.yaml` / `requirements.txt` / `Gemfile`, look for `.env.example`, look for a `supabase/` or `prisma/` or `migrations/` folder):

- **Platform**: web app, mobile app (React Native / Flutter / native), or both sharing a backend
- **Stack**: frontend framework, backend framework or BaaS (Supabase, Firebase, raw Postgres + Express, etc.), hosting target if known
- **Current stage**: still pre-launch with zero real users, or already live and being hardened under fire — this changes urgency and what can be done with zero downtime
- **What the user actually cares about**: someone who says "is this secure" wants a security pass; someone who says "will this hold up at 10k users" wants the scalability pass. Don't run the full five-pillar audit when they asked a narrower question, but do mention what else exists in case they want it next — see `references/communication-patterns.md` for how to frame this.

If the platform and stack aren't obvious from the repo structure within a minute or two of looking, ask — don't guess and burn a full audit pass on the wrong assumptions. One clarifying question beats a wrong audit.

### Step 2: Run the audit, not the fix

Resist the urge to start fixing things the moment something looks wrong. Mixing audit and remediation makes it hard for the user to see the full risk picture before deciding what to prioritize, and some fixes are cheap detours while others are real surgery — that judgment is easier with the whole list in front of you.

Work through `references/security-audit.md` top to bottom. It's organized by severity (critical → high → medium → low) and each item includes what to grep/check for, why it matters, and the fix pattern. For every item, actually check the codebase — don't mark something as an issue without having looked, and don't clear something as fine without having looked either.

If the app is mobile (React Native, Flutter, or native), also work through `references/mobile-hardening.md` — web security items still apply to the backend, but mobile adds its own surface (on-device secrets, certificate pinning, app store review requirements) that the web checklist doesn't cover.

Capture findings as you go in a simple running list: what's wrong, how severe, where in the code, roughly how big a fix. Don't write this up formally yet — that happens in Step 3.

### Step 3: Deliver findings before fixing anything

Once the audit pass is complete, present results to the user before writing remediation code. This matters for two reasons: critical-severity findings (exposed secrets, wide-open auth) often need an *immediate* stopgap — rotate the key, take the endpoint down — that's separate from and faster than the proper fix, and the user needs to know that distinction exists. And second, "production ready" covers a lot of ground; the user should choose where Claude spends effort rather than Claude unilaterally deciding to refactor the whole database layer.

Structure the findings conversationally (per `tone_and_formatting` — no heavy bullet/header walls for a chat response), grouped by severity, with the critical items called out clearly since those are the ones that have actually taken real products down. For each finding: what it is, where it lives, what it would take to fix.

If the codebase is large enough or the findings numerous enough that this is genuinely better read as a document than scrolled through in chat, write it as a markdown report via `create_file` rather than a wall of chat text — see `references/communication-patterns.md` for when to do this.

Then ask what to tackle first, or — if the user's intent was clearly "just fix it" — propose a fix order (critical security first, always) and confirm before starting.

### Step 4: Fix in priority order, verify as you go

Work through approved items using the fix patterns in the reference files as a starting point, adapted to the actual code rather than copy-pasted. After each fix, verify it actually closes the gap — re-run whatever check originally surfaced the issue (the grep, the manual test, the request that should now be rejected) rather than assuming the patch worked. A fix that looks right and doesn't actually close the hole is worse than no fix, because now everyone believes it's handled.

If a finding turns out to need a genuinely large change (e.g., switching from client-trusted auth to a real session model, or adding Row-Level Security to a database that has none), say so plainly rather than quietly shrinking the fix to fit — note the scope, do it properly, and if it's large enough to warrant its own conversation, say that too.

### Step 5: When scale, not just security, is the ask

If the user's concern is performance/scale rather than (or in addition to) security — "will this hold up," "it's slow with real traffic," "we're about to get featured somewhere" — work through `references/scalability-architecture.md`. This covers the database/query layer, caching, background jobs, and the structural technical-debt patterns (god functions, duplicated logic, no service layer) that accumulate specifically in AI-generated codebases and make every subsequent change slower. It's a separate reference because plenty of security audits don't need it and vice versa — pull it in based on what Step 1 surfaced about user intent.

### Step 6: Leave the codebase able to stay safe

A one-time audit doesn't stay true. Before wrapping up, check whether the basics are in place to catch *new* issues as the user keeps building — not by doing a separate huge project, but a few low-cost additions: is there a `.env.example` so secrets stop getting hardcoded going forward, does CI run anything (even just a linter and a secrets scanner) on new commits, is there a short note in the repo (a SECURITY.md or a section in the README) capturing the patterns that were just fixed so the next AI-assisted session doesn't reintroduce them. Mention these as optional, not mandatory — the user may already have this covered, or may not want it — but don't let a security pass be silently undone by the next vibe-coding session.

## Reference files

- `references/security-audit.md` — the core severity-ordered vulnerability checklist (auth, injection, access control, secrets, headers, rate limiting, file uploads, webhooks, error handling). Use for any production-readiness or security request, web or mobile-backend.
- `references/mobile-hardening.md` — mobile-specific additions on top of the security audit: on-device secret storage, certificate pinning, OWASP Mobile Top 10, app store review gotchas, offline/sync data integrity. Use only when the app is mobile.
- `references/scalability-architecture.md` — database/query optimization, caching, background jobs, observability, and the architectural technical-debt patterns specific to AI-generated code. Use when the ask is about scale, performance, or long-term maintainability rather than (or in addition to) security.
- `references/communication-patterns.md` — how to frame findings for users who range from non-technical (vibe-coded their first app) to experienced engineers, how to decide chat vs. document output, and language to avoid (fear-mongering, vague "best practices" hand-waving).

Read the relevant reference file(s) in full before starting the audit for that area — don't rely on summaries above, since the actual check-and-fix detail lives in the reference, not in this routing file.
