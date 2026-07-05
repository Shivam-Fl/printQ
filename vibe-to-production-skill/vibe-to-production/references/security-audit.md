# Security Audit Checklist

Severity-ordered. Work top to bottom — critical items are the ones that have actually taken down real vibe-coded products with no sophisticated attack required, so they come first regardless of what else looks interesting in the code.

For every item: actually check the codebase before marking it pass or fail. The "check" line tells you how. Don't skip an item because the stack seems unlikely to have it — Supabase apps get IDOR just as often as raw-Postgres apps, just via a different mechanism.

---

## CRITICAL

### 1. Missing database-level access control (no Row-Level Security / equivalent)

**Why it matters**: This is the single most common critical finding in vibe-coded apps using Supabase, Firebase, or any BaaS with a client-callable database. The app's UI might only show a user their own data, but if the database itself has no row-level restriction, anyone who can read the API key (which, on the client, they always can — see #5) can query any row directly, bypassing the UI entirely.

**Check**:
- Supabase: in the dashboard or via `supabase db dump`, check whether RLS is enabled on every table holding user data. A table with RLS disabled and a public/anon key is fully readable by anyone.
- Firebase: check `firestore.rules` / `database.rules.json` — look for rules that default-allow (`allow read, write: if true;`) or that check nothing beyond `request.auth != null` when they should be checking ownership (`request.auth.uid == resource.data.userId`).
- Generic backend: confirm every query that returns user-scoped data filters by the authenticated user's ID server-side, not just client-side.

**Fix pattern** (Supabase):
```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own orders"
  ON orders FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own orders"
  ON orders FOR INSERT
  WITH CHECK (auth.uid() = user_id);
```
Write explicit policies for select, insert, update, and delete separately — a table with only a SELECT policy still allows unrestricted writes. Test by logging in as two different test users and confirming neither can see or modify the other's rows, not just by reading the policy and assuming it's correct.

**Fix pattern** (Firestore):
```
match /orders/{orderId} {
  allow read, update, delete: if request.auth != null
                                && request.auth.uid == resource.data.userId;
  allow create: if request.auth != null
                && request.auth.uid == request.resource.data.userId;
}
```

---

### 2. Unprotected API routes (no auth middleware)

**Why it matters**: Routes that read or mutate data but don't verify the caller is authenticated and authorized for that specific resource. Often happens because the route worked fine during development (the developer was always logged in, testing their own data) and the auth check was never added because nothing ever failed to demonstrate its absence.

**Check**: List every API route/handler. For each one that touches non-public data, trace whether there's a check that (a) the request is authenticated at all, and (b) the authenticated user is allowed to access *this specific resource* — not just any resource of that type. (a) without (b) is IDOR, covered separately below since it's common enough to need its own item.

```bash
# quick first pass - find routes with no apparent auth check nearby
grep -rn "router\.\(get\|post\|put\|delete\|patch\)\|app\.\(get\|post\|put\|delete\|patch\)" --include="*.ts" --include="*.js" -A 3 . | grep -B3 -v "auth\|requireUser\|isAuthenticated\|getServerSession\|verifyToken"
```
This is a starting point, not a verdict — read each route Claude flags by hand, since middleware applied globally (e.g., in a route group or framework-level guard) won't show up adjacent to the handler.

**Fix pattern** (Express/Node):
```javascript
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = verifyJWT(token); // throws on invalid/expired
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

router.get('/api/orders/:id', requireAuth, async (req, res) => {
  const order = await db.orders.findUnique({ where: { id: req.params.id } });
  if (!order || order.userId !== req.user.id) {
    return res.status(404).json({ error: 'Not found' }); // 404, not 403 - don't confirm existence
  }
  res.json(order);
});
```
Note the 404-not-403 detail in the ownership check — returning 403 ("forbidden") confirms to an attacker that the resource exists and just isn't theirs, which is itself a minor information leak. 404 reveals nothing.

---

### 3. Committed secrets (.env files, API keys, credentials in git history)

**Why it matters**: AI coding assistants frequently write secrets directly into example files, test files, or the code itself during scaffolding, and a `.env` committed once and later added to `.gitignore` is still in git history forever unless that history is rewritten. A secret in a public repo is compromised the moment it's pushed, not the moment someone finds it — assume it's already been scraped.

**Check**:
```bash
# is .env or similar tracked right now?
git ls-files | grep -E "^\.env$|^\.env\.local$|^\.env\.production$"

# has it EVER been committed, even if removed since?
git log --all --full-history -- "*.env" "*.env.local" "*.env.production"

# scan for secret-shaped strings anywhere in the current tree
grep -rnE "(api[_-]?key|secret|password|token)['\"]?\s*[:=]\s*['\"][A-Za-z0-9_\-]{16,}" --include="*.ts" --include="*.js" --include="*.py" --include="*.json" . | grep -v "node_modules\|\.env\.example\|process\.env\|os\.environ"
```
If anything other than `.env.example` (with placeholder values) is tracked, or if `git log` shows a real `.env` was ever committed, treat every secret in it as compromised — rotating the key is mandatory, not optional, removing the file from the current tree is not sufficient.

**Fix**:
1. Rotate every credential that was ever exposed — new API keys, new database password, new JWT signing secret. This is the step people skip and it's the one that actually matters; removing the file from git doesn't un-expose a key that's already in scrapeable history.
2. Add `.env`, `.env.local`, `.env.production` to `.gitignore` if not already there.
3. Commit a `.env.example` with the variable names and placeholder values, so the pattern is documented without the actual secrets.
4. If history needs cleaning (not always necessary once keys are rotated, but worth doing for a public repo): `git filter-repo` or BFG Repo-Cleaner — mention this exists rather than running it unprompted, since rewriting history is disruptive for any collaborators and the user should opt in.

---

### 4. Broken access control / IDOR (Insecure Direct Object Reference)

**Why it matters**: The most common single vulnerability class across all of these audits. An endpoint checks that *a* user is logged in, but not that *this* user owns the specific resource being requested — so changing `/api/invoices/4471` to `/api/invoices/4472` in the URL returns someone else's invoice. This is items #1 and #2 from a different angle: #1 is the database not enforcing it, #2 is the route not checking auth at all, IDOR is the route checking auth but not ownership.

**Check**: For every route that takes a resource ID (`:id`, `?orderId=`, etc.) and returns or mutates data, confirm the handler verifies `resource.ownerId === currentUser.id` (or the team/org equivalent) before responding — not just that *some* valid session exists. Test manually: log in as user A, note an ID belonging to user B (sequential IDs make this trivial to guess), and request it as user A. If it succeeds, that's a live IDOR.

```bash
# find resource-fetching routes that take an ID param
grep -rn "req\.params\.id\|req\.query\.\(id\|.*Id\)" --include="*.ts" --include="*.js" .
```
Then manually trace each result for an ownership check, since this pattern can't be reliably grepped for — the absence of a check is what's being looked for, not a string to match.

**Fix**: Same pattern as #2's fix — filter the query by both the resource ID *and* the owner ID, don't fetch by ID alone and check ownership after the fact (that's also vulnerable if the post-check is missing on a code path added later). Prefer baking the ownership filter into the query itself:
```javascript
// vulnerable: fetches by ID alone, ownership check is a separate, skippable step
const invoice = await db.invoice.findUnique({ where: { id } });

// safer: ownership is part of the query, can't return someone else's row
const invoice = await db.invoice.findFirst({ where: { id, userId: req.user.id } });
```

---

### 5. Secret API keys shipped in frontend/client code

**Why it matters**: Anything in client-side JavaScript, a mobile app binary, or a bundled frontend build is fully visible to anyone who opens dev tools or decompiles the app — `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_` prefixed env vars and anything passed into client components are not secret, they're just obfuscated by being in a bundle. A *secret* key (one that grants write access, billing access, or admin scope) shipped this way is equivalent to publishing it.

**Check**:
```bash
# anything with a public/client prefix that looks like a real secret, not a publishable key
grep -rnE "NEXT_PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_" --include="*.ts" --include="*.tsx" --include="*.js" . | grep -iE "secret|service[_-]?role|admin|private[_-]?key"
```
Also check the actual built/bundled output if available (`grep` the `dist/` or `.next/` build for known secret prefixes like `sk_live_`, `sk_test_` for Stripe, or a Supabase `service_role` key) — what's intended to stay server-side sometimes leaks into the bundle via an import chain the developer didn't trace.

**Important distinction**: some keys are *designed* to be public — a Stripe *publishable* key (`pk_...`), a Supabase `anon` key (meant to be public *because* RLS, item #1, is what actually protects the data), a Google Maps client key restricted by domain/referrer. Shipping these is fine. The check is specifically for *secret*-tier keys (`sk_...`, `service_role`, database connection strings, signing secrets) ending up client-side.

**Fix**: Move any genuinely secret operation behind a server route the client calls instead of holding the key itself:
```javascript
// client calls your own backend, never the third-party API directly
const res = await fetch('/api/checkout-session', { method: 'POST', body: JSON.stringify({ priceId }) });

// server route holds the real secret key
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY); // no NEXT_PUBLIC_ prefix
```

---

## HIGH

### 6. Server-Side Request Forgery (SSRF)

**Why it matters**: If the app fetches a URL on the server based on user input (webhook URLs, image-from-URL upload, link previews, PDF-from-URL generation), an attacker can point that fetch at internal infrastructure — `http://169.254.169.254/` (cloud metadata endpoints), `http://localhost:internal-admin-port`, or internal services not meant to be internet-reachable.

**Check**: search for server-side `fetch`/`axios`/`requests.get` calls where the URL comes from request body/query rather than being a fixed, developer-controlled constant.
```bash
grep -rn "fetch(req\.\|axios.get(req\.\|requests\.get(request\." --include="*.ts" --include="*.js" --include="*.py" .
```

**Fix**: validate and allowlist before fetching — block private IP ranges, localhost, and link-local addresses (`169.254.0.0/16`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), resolve DNS before connecting and check the resolved IP isn't on that list (an attacker can register a public domain that resolves to a private IP), and if possible restrict to an explicit domain allowlist rather than "any URL."

---

### 7. Missing CSRF protection

**Why it matters**: For any state-changing endpoint relying on cookie-based session auth (not pure bearer-token APIs), a malicious page can trigger a request using the victim's existing session cookie without their knowledge, if the server doesn't verify the request actually originated from the app's own frontend.

**Check**: if auth is cookie/session-based, confirm state-changing routes (POST/PUT/DELETE) check a CSRF token or use `SameSite=Strict`/`SameSite=Lax` cookies plus origin verification. Bearer-token (`Authorization: Bearer ...`) APIs are inherently less exposed to classic CSRF since the token isn't auto-attached by the browser, but verify that's actually the auth mechanism in use rather than assuming it.

**Fix**: framework-provided CSRF middleware (most modern frameworks ship one — Next.js server actions, Rails, Django, Laravel all have built-in protection that just needs to not be disabled) is preferable to hand-rolling, plus set cookies with `SameSite=Lax` or `Strict` and `Secure` as a second layer.

---

### 9. Wildcard CORS

**Why it matters**: `Access-Control-Allow-Origin: *` combined with credentialed requests (cookies, auth headers) means any website on the internet can make authenticated requests to the API from a visitor's browser and read the response. This is frequently set during development to "stop the CORS errors" and never narrowed before launch.

**Check**:
```bash
grep -rn "Access-Control-Allow-Origin\|cors(" --include="*.ts" --include="*.js" --include="*.py" .
```
Look specifically for `origin: '*'`, `origin: true` without a function, or a hardcoded `*` header.

**Fix**: allowlist explicit origins.
```javascript
const allowedOrigins = ['https://yourapp.com', 'https://app.yourapp.com'];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
```

---

### 11. SQL injection

**Why it matters**: AI assistants commonly generate query-building code using string concatenation or template literals instead of parameterized queries, especially for "dynamic" queries (search, filtering, sorting) where the lazy path is gluing user input directly into the SQL string. It compiles, returns correct results in normal testing, and is fully exploitable.

**Check**:
```bash
grep -rnE "(query|execute)\(.*(\+|\\\$\{|%s.*%|f['\"])" --include="*.ts" --include="*.js" --include="*.py" . | grep -v "node_modules"
```
Any raw SQL built via string concatenation or an f-string/template-literal with user input interpolated directly is a hit. ORMs (Prisma, Drizzle, SQLAlchemy's query builder, ActiveRecord) parameterize by default when used normally — the risk is specifically raw query escapes (`$queryRawUnsafe`, `.raw()`, manually constructed strings).

**Fix**: parameterized queries everywhere, no exceptions for "it's just an internal admin tool" or "it's read-only."
```javascript
// vulnerable
const result = await db.query(`SELECT * FROM users WHERE email = '${email}'`);

// safe - parameterized
const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
```

---

### 12. Cross-site scripting (XSS)

**Why it matters**: User-controlled content rendered into the page without escaping lets an attacker inject a script that runs in another user's session — stealing cookies, session tokens, or performing actions as them. Most modern frontend frameworks (React, Vue, Svelte) auto-escape by default, which is exactly why the actual risk concentrates in the places where a developer explicitly opted out of that protection.

**Check**:
```bash
grep -rn "dangerouslySetInnerHTML\|v-html\|innerHTML\s*=\|\{@html" --include="*.tsx" --include="*.jsx" --include="*.vue" --include="*.svelte" .
```
Every hit is a place auto-escaping was deliberately bypassed — confirm the content being inserted is either fully developer-controlled (fine) or sanitized through a library like DOMPurify before insertion (also fine), or neither (vulnerable).

**Fix**:
```javascript
import DOMPurify from 'dompurify';
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(userContent) }} />
```
If the content doesn't actually need to render as HTML (most user-generated text doesn't), the better fix is removing the `dangerouslySetInnerHTML`/`v-html` entirely and rendering as plain text, which the framework escapes automatically.

---

### 13. Unverified webhook signatures (Stripe, etc.)

**Why it matters**: Webhook endpoints (payment confirmations, subscription updates) that don't verify the request actually came from the claimed provider can be spoofed — an attacker POSTs a fake "payment succeeded" event directly to the webhook URL and the app grants access or marks an order paid without any money having moved.

**Check**: find the webhook handler and confirm it verifies a signature header against a webhook signing secret before trusting the payload, rather than just parsing and acting on the JSON body.
```bash
grep -rn "webhook\|stripe.*event" --include="*.ts" --include="*.js" --include="*.py" .
```

**Fix** (Stripe):
```javascript
const sig = req.headers['stripe-signature'];
let event;
try {
  event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
} catch (err) {
  return res.status(400).send(`Webhook signature verification failed`);
}
// only now is event trustworthy
```
Also confirm idempotency — a webhook can legitimately fire more than once for the same event, so the handler should check whether it's already processed this event ID before acting again (e.g., already marked this order paid), or a retried webhook double-grants whatever it grants.

---

## MEDIUM

### 8. Missing security headers

**Check**: confirm the app sets, at minimum, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (or a `Content-Security-Policy` `frame-ancestors` directive), and a reasonable `Content-Security-Policy`. Most frameworks have a one-line middleware for this rather than requiring hand-setting each header.

**Fix** (Node/Express): `helmet()` middleware applied at the app level covers most of this in one line. For Next.js, set headers in `next.config.js` under the `headers()` function. Don't hand-roll a CSP from scratch without checking what the app actually loads (inline scripts, third-party widgets) — an overly strict CSP applied blindly will break the app, so test after adding it.

### 10. No rate limiting

**Why it matters**: Without rate limiting, login endpoints are brute-forceable, password reset endpoints can be used to enumerate valid emails, and any expensive endpoint (search, AI-backed features, file generation) can be hammered to run up cost or degrade service for everyone else.

**Check**: confirm rate limiting exists, and that it's tiered appropriately — a login or password-reset endpoint needs a much tighter limit (e.g., 5/minute) than a general read endpoint (e.g., 100/minute), and per-user limits matter for authenticated routes while per-IP limits matter for unauthenticated ones.

**Fix**: middleware-level (`express-rate-limit`, Next.js middleware with a Redis/Upstash backend, or platform-level if hosted on something with built-in rate limiting like Vercel or Cloudflare) is preferable to hand-rolled. Return `429 Too Many Requests` with a `Retry-After` header rather than a generic error.

### 14. Insecure file uploads

**Check**: confirm uploaded files are validated by actual content/magic bytes (not just trusting the client-supplied filename extension or MIME type, both of which are trivially spoofable), size-limited, stored outside the web root or in object storage rather than a directly-executable server directory, and served with a `Content-Disposition` that prevents execution-on-access for anything that isn't explicitly meant to be inline-rendered.

**Fix**: validate file type via library (e.g., `file-type` in Node, which reads magic bytes rather than trusting the extension), enforce a max size before the upload completes (not just after, which still costs bandwidth/storage for an oversized rejected file), and store in object storage (S3, R2, Supabase Storage) with a randomly generated filename rather than the user-supplied one, which also sidesteps path traversal.

### 16. Weak password hashing

**Check**:
```bash
grep -rn "md5\|sha1(.*password\|createHash.*password" --include="*.ts" --include="*.js" --include="*.py" .
```
Anything hashing passwords with a fast general-purpose hash (MD5, SHA-1, even unsalted SHA-256) instead of a slow, purpose-built password hash is a finding — fast hashes are brute-forceable at billions of attempts/second on modern hardware.

**Fix**: bcrypt, argon2, or scrypt — all are deliberately slow and salt automatically. If using an auth provider (Supabase Auth, Clerk, Auth0, Firebase Auth, NextAuth with a database adapter) this is usually handled correctly out of the box; the risk concentrates in apps that rolled their own auth.
```javascript
import bcrypt from 'bcrypt';
const hash = await bcrypt.hash(password, 12); // cost factor 12 is a reasonable default in 2026
const valid = await bcrypt.compare(inputPassword, storedHash);
```

---

## LOW

### 15. Verbose error messages

**Why it matters**: Stack traces, raw database errors, or internal file paths returned to the client in production hand an attacker a map of the app's internals (ORM in use, table/column names, file structure) and sometimes leak data directly (a database constraint violation error can confirm whether an email already exists, useful for account enumeration).

**Check**: confirm the production error handler returns a generic message to the client while logging the full error server-side, rather than passing `err.message` or `err.stack` straight through to the response.

**Fix**:
```javascript
app.use((err, req, res, next) => {
  console.error(err); // full detail, server-side only
  res.status(500).json({ error: 'Something went wrong' }); // generic, client-facing
});
```

### 17. Hallucinated packages (slopsquatting)

**Why it matters**: AI assistants sometimes generate `import`/`require` statements or `package.json` entries for packages that don't actually exist on npm/PyPI — a plausible-sounding name that was never a real package. Attackers monitor for exactly this pattern and pre-register the hallucinated names with malicious code, betting that someone will `npm install` it without checking. Roughly one in five AI-generated code samples reference at least one non-existent package, so this isn't a rare edge case.

**Check**: for every dependency in `package.json`/`requirements.txt`/`Gemfile` (especially ones that feel unfamiliar or were added during AI-assisted sessions rather than deliberately chosen), confirm it actually exists on the relevant registry and has a plausible install count/history — not zero downloads from a week-old account.
```bash
# spot-check: does this exact name exist and have real history?
npm view <package-name> # or: pip index versions <package-name>
```

**Fix**: remove and replace any package that turns out to be hallucinated or suspicious before it's ever installed in a real environment. If it was already installed, treat it as a potential compromise — check what it actually did during `postinstall`, not just what it claims to do.

---

## After the pass: dependency and supply-chain check

Not part of the numbered list above since it's an ongoing process rather than a one-time code check, but should be run alongside the audit:

```bash
npm audit            # or: pip-audit / bundle audit, depending on stack
```
Triage by actual exploitability in this app's context, not raw count — a "critical" vulnerability in a dev-only dependency that never ships to production carries very different risk than the same severity in something on the request path. Don't just run `npm audit fix --force` reflexively; it can introduce breaking major-version bumps. Review what it's proposing first.
