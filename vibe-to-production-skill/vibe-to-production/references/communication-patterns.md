# Communication Patterns

The audience for this skill ranges from a solo founder who built their first app with AI and has no prior coding background, to a senior engineer hardening a team-built product before enterprise launch. The information being communicated doesn't change, but how it's framed needs to match the person actually reading it.

---

## Reading the user's technical level

Don't ask. Infer from context signals:

- The tool they mention using: Lovable/Bolt/v0 users skew less technical than Cursor/Windsurf/Claude Code users (though not always)
- How they describe the problem: "is this secure" → probably wants guidance, not code diffs; "check for IDOR vulnerabilities" → knows what they're looking for
- What their codebase looks like: if they have tests, a proper `.env` setup, and a CI workflow, they've been around; if there's no `package.json` and credentials are in `app.js`, they're newer
- How they respond to first findings: if they ask what "RLS" stands for, adjust; if they start asking about the Prisma `findFirst` vs `findMany` trade-offs, match that level

When uncertain, default to brief jargon-free explanations alongside any technical fix (a sentence saying what it is in plain terms before the code block), so technical users can skip the explanation and newer users get it without having to ask.

---

## Framing security findings without fear-mongering

Security findings can be framed in ways that feel terrifying ("your entire database is exposed!") or underwhelming ("minor access control issue noted"). Neither is useful. The goal is accurate calibration: the user understands the real-world consequence of each finding, can prioritize correctly, and feels capable of addressing it.

**For critical findings** — be direct about consequence, without dramatizing:
- "This means anyone with your API URL (which is public once the app is live) can read any row in this table without logging in. That includes your users' email addresses and order history. Rotating the key and enabling RLS closes it — the fix is about 30 minutes of work."
- *Not*: "⚠️ CRITICAL VULNERABILITY — YOUR ENTIRE DATABASE IS EXPOSED AND ATTACKERS CAN STEAL ALL YOUR DATA"

**For findings that are real but lower-priority**:
- "This is worth fixing before you're handling significant user data, but it's not an immediate stop-everything issue. It's in the backlog territory."
- *Not*: treating every medium finding with the same urgency as a critical one, which either induces panic or trains the user to tune everything out

**Avoid**:
- "Best practice says..." — this means nothing to a solo builder; say what the concrete consequence of *not* doing it is
- "You should really consider..." — commit to a recommendation or don't make it
- Vague reassurances: "just a few small things to address" when there are three critical findings

---

## When to respond in chat vs. write a report file

**Chat response** (most cases):
- 5 or fewer distinct findings
- User asked a specific question ("is my auth vulnerable", "check my webhooks")
- The conversation is exploratory or back-and-forth in nature
- Findings are all in one severity tier

**Report file** (write via `create_file`, present via `present_files`):
- 8+ findings across multiple severity tiers — a wall of chat text loses structure
- User explicitly asked for an audit report or a document to share with a team/investor
- The app has multiple components (frontend, backend, mobile) with separate finding sets
- There are going to be more rounds of work and a persistent document to track progress is useful

**Report structure** when writing one:
```markdown
# Production Readiness Audit — [App Name]
Date: [current date]

## Summary
[2-3 sentences: overall posture, critical count, key themes]

## Critical (fix before any public launch)
### [Finding name]
**What it is**: ...
**Where**: `path/to/file.ts:42`
**Consequence**: ...
**Fix**: ...

## High (fix within the first sprint post-launch)
...

## Medium / Low
...

## Next steps
[Prioritized action list]
```

---

## Framing the scope conversation (Step 1 in the workflow)

When opening a session that isn't clear-cut, frame the scope question as a practical choice, not a gatekeeping quiz:

- "Before I look at the code, it helps to know: is this already getting real users, or is this a pre-launch hardening pass? The priorities are a bit different — pre-launch I'd start with the security fundamentals; live-and-growing I'd also look at what might start failing under load."
- "Is your main concern security (protecting user data, making sure auth is solid), performance/scale (will this hold up with more users), or both? Either is fine — knowing upfront means I spend time on what matters to you."

One question at a time. Not a checklist of clarifying questions — that's friction. One practical, consequence-grounded question that unlocks the right focus.

---

## The "it's already live" scenario

Users sometimes disclose mid-audit that the app already has real users — perhaps more than they expected, or they didn't realize they were supposed to harden it first. This is common and doesn't need moralizing.

When a critical finding exists in a live app:
1. Say what the immediate stopgap is (not the full fix — the thing they can do in 5 minutes that reduces exposure while the fix is being implemented): "The fastest thing is to enable RLS with a deny-all policy right now, then we'll add the correct user-scoped policies."
2. Separate that from the proper fix, so they don't mistake the stopgap for done.
3. Don't editorialize about the fact that it's already live — they know; what they need is what to do, not a lecture.

---

## Recommending ongoing tooling

At the end of an audit, it's worth mentioning tools that extend the safety net beyond the one-time pass — but frame these as options, not obligations, and match them to the user's apparent setup and sophistication:

**For non-technical / solo builders**:
- "Add [Sentry](https://sentry.io) — it's a few lines of setup and tells you immediately when something breaks in production, instead of waiting for a user to complain."
- "Enable [GitHub's Dependabot](https://docs.github.com/en/code-security/dependabot) on the repo — it automatically opens PRs when a dependency has a known vulnerability."

**For teams with CI/CD already set up**:
- Add `npm audit --audit-level=high` to the CI workflow — fails the build on high-severity dependency vulnerabilities
- Add `detect-secrets` or `git-secrets` to the pre-commit hook — catches accidentally committed credentials before they hit the repo
- Add a basic integration test for the most critical auth flows (login, resource access as wrong user) — these are the things most likely to silently regress

**For apps approaching serious scale**:
- Set up structured logging with a log aggregation service and configure alerts
- Add a database slow-query log (Postgres: `log_min_duration_statement`)
- Consider a scheduled penetration test before a significant launch or before handling payment/health data at volume

Frame these as "things that keep what we just fixed from breaking again" rather than "things you should have had all along."
