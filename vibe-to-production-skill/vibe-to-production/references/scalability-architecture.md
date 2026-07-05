# Scalability and Architecture

Use this reference when the user's concern is performance, scale, or long-term maintainability — either instead of, or after, the security audit. The security audit covers what breaks immediately; this covers what breaks at 1,000 users, what becomes unmaintainable at 100 features, and what sends cloud costs to 400% of projections.

The five pillars a production app needs to stand on are: Security (covered in security-audit.md), Reliability, Performance, Observability, and Maintainability. This file covers the last four.

---

## Pillar 1: Database and query layer

The database is where vibe-coded apps most reliably accumulate expensive technical debt. AI assistants generate locally-correct queries (they return the right data) while missing the global properties that make them scale (they do so efficiently, with indexes, without scanning the whole table). An unindexed query against a 100-row dev database is instant. The same query against a 10-million-row production table, run on every login, will pin database CPU at 90% and eventually stop taking new connections.

### Indexes

**Check**: for every column that appears in a `WHERE`, `JOIN`, or `ORDER BY` clause, confirm an index exists on that column (or that the column is the first in a composite index that covers the query's filter). Most ORMs don't create indexes automatically beyond the primary key.

```sql
-- For Postgres: list existing indexes
SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename;

-- Find large sequential scans (queries hitting every row) in a Postgres instance with pg_stat_user_tables
SELECT relname AS table, seq_scan, idx_scan FROM pg_stat_user_tables ORDER BY seq_scan DESC;
```

A table with `seq_scan >> idx_scan` is almost always missing the right index for its common access patterns. Cross-reference with the queries actually running against it.

**Fix**: add indexes on high-cardinality filter columns. Don't over-index (every index slows writes and takes space) — focus on columns actually appearing in `WHERE`/`JOIN`/`ORDER BY` in the hot paths identified by the scan stats or by reading the actual query code.

```sql
CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders(user_id);
CREATE INDEX CONCURRENTLY idx_orders_status_created_at ON orders(status, created_at DESC);
```

`CONCURRENTLY` builds the index without locking the table — critical for adding indexes to a live production database without downtime.

### N+1 queries

**Why it matters**: a list page that loads 20 items and then fires a separate query for each item's related data runs 21 queries where 1 (or 2 with a join) would do. This is virtually impossible to see in development (20 fast queries is still fast) and brutal at scale (20 queries × 1,000 concurrent users = 20,000 queries from a single page load).

**Check**: look for queries inside loops, or ORM calls inside `.map()` / `for...of` iterating over a list of records:
```bash
grep -rn "\.map.*await\|for.*await.*find\|forEach.*await" --include="*.ts" --include="*.js" --include="*.py" .
```
Every `await db.find...` inside a loop over a record set is a candidate N+1. Confirm by logging query counts in development (Prisma's `log: ['query']` option, SQLAlchemy's query logging, etc.) and checking whether a single route fires more queries than it should.

**Fix** (Prisma):
```javascript
// N+1: one query per order to get its items
const orders = await db.order.findMany({ where: { userId } });
const withItems = await Promise.all(
  orders.map(o => db.orderItem.findMany({ where: { orderId: o.id } })) // N extra queries
);

// Fixed: single query with include
const orders = await db.order.findMany({
  where: { userId },
  include: { items: true }, // JOIN in one query
});
```

### Query optimization

- **Avoid `SELECT *`** in any query that runs frequently — fetch only the columns you need. This matters most for wide tables and when the query result gets serialized over the wire to the client.
- **Paginate everything** that returns a list of user-controlled size. A vibe-coded `findMany()` with no `take`/`limit` will eventually return tens of thousands of rows when a user has a lot of data, and everything downstream (serialization, network, client render) will suffer.
- **Prefer aggregation in the database** over fetching everything and reducing in app code — `SELECT COUNT(*), SUM(amount) FROM orders WHERE user_id = $1` is dramatically faster than fetching every order row and totaling it in JavaScript.
- **Database migrations**: AI-generated schema changes often skip proper migrations and suggest dropping/recreating tables, which loses production data. Confirm there's a migration workflow (Prisma Migrate, Flyway, Alembic, Active Record migrations) and that it's being used — not raw `ALTER TABLE` statements applied by hand and not tracked anywhere.

---

## Pillar 2: Caching

Before adding a cache, profile first — caching is real complexity (invalidation, stale data, cache-stampede on cold start) and shouldn't be added speculatively. The right question is "which operations are both expensive and read-frequently-relative-to-how-often-they-change?"

**Common patterns in vibe-coded apps that benefit from caching**:
- Dashboard aggregate queries ("total revenue this month", "order count by status") — expensive to compute from scratch on every page load, change infrequently
- User profile data fetched on every authenticated request — almost never changes between requests, a brief TTL cache per user ID avoids repeated DB reads
- External API calls with rate limits (weather APIs, geocoding, AI completions) — shouldn't be called on every request if the data can be reused

**Simple in-memory cache**: appropriate for single-instance apps where the cache doesn't need to survive restarts and doesn't need to be consistent across multiple app instances.

**Redis/Upstash cache**: appropriate when the app runs as multiple instances (any containerized or serverless deployment), needs cache-to-persist-across-restarts, or the cached data needs a proper invalidation event (not just TTL expiry).

**Fix pattern** (simple TTL cache, no external dependency):
```javascript
const cache = new Map(); // or a proper LRU library like 'lru-cache'

async function getDashboardStats(userId) {
  const cacheKey = `stats:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 60_000) return cached.data;
  
  const data = await computeExpensiveStats(userId);
  cache.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}
```

**Fix pattern** (Redis / Upstash):
```javascript
import { Redis } from '@upstash/redis';
const redis = new Redis({ url: process.env.UPSTASH_REDIS_URL, token: process.env.UPSTASH_REDIS_TOKEN });

async function getDashboardStats(userId) {
  const cached = await redis.get(`stats:${userId}`);
  if (cached) return cached;
  
  const data = await computeExpensiveStats(userId);
  await redis.setex(`stats:${userId}`, 60, data); // TTL 60 seconds
  return data;
}
```

**Cache invalidation**: every cache entry needs to be invalidated (either via TTL expiry or explicit `del`) when the underlying data changes. Forgetting this is how users see stale data. Keep TTLs short for anything where staleness matters; only cache things that can be briefly wrong without breaking user trust.

---

## Pillar 3: Background jobs and async processing

AI-generated apps tend to do everything synchronously in the request handler, including things that shouldn't block the HTTP response: sending emails, processing file uploads, generating reports, calling slow third-party APIs. This makes the API feel slow and means a user's action "fails" if a background task fails.

**Identify what should be async**:
- Sending emails / push notifications
- Resizing / transcoding / processing uploaded files
- Generating exports, reports, PDFs
- Calling external APIs that might be slow or fail with retries needed
- Any operation where the user doesn't need the result immediately

**Simple approach**: for apps not yet at scale, a fire-and-forget promise (the HTTP response returns immediately while the work continues) works as a stepping stone — but the work is lost if the process crashes, and there's no retry on failure. Suitable for non-critical tasks on low-traffic apps.

**Production approach**: a proper job queue. Options by stack:
- **Node.js**: BullMQ (Redis-backed), or serverless-native options like Inngest / Trigger.dev / Cloudflare Queues
- **Python**: Celery (Redis or RabbitMQ broker) or Hatchet
- **All stacks on serverless infrastructure**: the platform's native queue (SQS, Pub/Sub, Supabase Edge Function background tasks)

A job queue gives persistence (jobs survive process restarts), retries (automatic retry with backoff on transient failures), and visibility (see what's queued, what failed, and why).

---

## Pillar 4: Observability

You can't fix what you can't see. AI-generated apps often ship with no structured logging, no error tracking, and no performance monitoring — which means the first sign that something is wrong is a user complaint rather than an alert that fired before anyone noticed.

### Error tracking

**Add this first** — it's the highest-value monitoring for the lowest effort, and it immediately pays for itself the first time something breaks in production.

- **Sentry** is the most common option across all stacks (a few lines of SDK initialization, free tier for small apps)
- For Supabase apps, Sentry can be initialized in both the frontend and Edge Functions
- Configure it to alert on new error types, not just every occurrence — you want to know when something breaks, not receive 10,000 notifications about the same thing

**Add user context** to error reports — knowing *which* user hit an error is often the difference between able-to-reproduce and a mystery:
```javascript
Sentry.setUser({ id: session?.user?.id, email: session?.user?.email });
```

### Structured logging

`console.log("something happened")` is not observability. Structured logs (JSON objects with consistent fields) are searchable, filterable, and aggregatable.

```javascript
// unstructured - hard to query for later
console.log(`Order ${orderId} failed: ${error.message}`);

// structured - queryable by any field
logger.error('order_failed', {
  orderId,
  userId,
  error: error.message,
  errorCode: error.code,
  duration_ms: Date.now() - startTime,
});
```

For small apps, structured `console.log` with JSON output (which Vercel, Railway, and Fly.io all capture and make searchable) is often sufficient. For larger apps, a log aggregation service (Datadog, Logtail, Axiom, Grafana Loki) adds full-text search and alerting.

### Performance monitoring

- **Web Vitals / Lighthouse**: for web apps, track Core Web Vitals (LCP, FID/INP, CLS) — these affect both user experience and SEO. Add `@vercel/speed-insights` (Vercel) or a standalone RUM (Real User Monitoring) SDK
- **Database query timing**: the most common source of slowness in vibe-coded apps. Log slow queries (Postgres: `log_min_duration_statement = 1000` to log anything over 1 second), and review them weekly
- **API endpoint latency**: measure p50/p95/p99 latency per endpoint — averages hide the tail that's actually ruining some users' experience

### Alerts

Monitoring that doesn't alert is decoration. Set up at minimum:
- Alert when error rate exceeds a threshold (5 new error types in 5 minutes, or absolute count exceeds a per-endpoint baseline)
- Alert when database CPU or connection pool saturation exceeds 70% (this is often the first sign of a query going wrong at scale)
- Uptime check — a simple HTTP ping every minute that alerts if the app stops responding

---

## Pillar 5: Maintainability (AI-generated code debt patterns)

These are the structural issues that are unique to or severely amplified by vibe-coded codebases. They don't cause immediate bugs but make every subsequent feature twice as hard.

### God functions

AI coding assistants generate large, single-function implementations that handle everything in one place — form validation, database write, email send, Stripe charge, state update — because each prompt is answered in isolation. 300-line functions that handle four concerns are the most common pattern.

**Check**: function length is a proxy metric. Any function over ~50 lines is a candidate for review. The real test is "can I describe what this function does in one sentence?" — if the answer requires "and" or a semicolon, it's doing too much.

**Fix**: extract by concern. Don't extract just to hit a line count — extract to a function whose name says exactly what it does, that can be read and tested independently.

```javascript
// before: one handler doing everything
async function handleCheckout(req, res) {
  // validate input (20 lines)
  // look up user (5 lines)
  // create Stripe session (15 lines)
  // create DB record (10 lines)
  // send email (10 lines)
  // return response (5 lines)
}

// after: composed from single-purpose functions
async function handleCheckout(req, res) {
  const input = validateCheckoutInput(req.body);            // throws on invalid
  const user = await getUserOrThrow(req.user.id);
  const session = await createStripeSession(user, input);
  const order = await createPendingOrder(user, session);
  await sendOrderConfirmationEmail(user, order);
  res.json({ sessionUrl: session.url });
}
```

### Duplicated logic

AI-assisted sessions generate code from context, not from a global understanding of what already exists — so the same validation logic, the same formatting function, or the same API call pattern gets written three different times, slightly differently, in three different files. When the logic needs to change, it gets changed in one place and the others silently drift.

**Check**:
```bash
# rough similarity scan - this flags files that might have duplicated patterns
# a more precise approach is to skim the handler/service files for repeated structures
grep -rn "const validateEmail\|function validateEmail\|def validate_email" --include="*.ts" --include="*.js" --include="*.py" .
```
Look specifically for: validation logic (email format, password strength, phone number), date/number formatting, auth token extraction from headers (commonly duplicated across middleware and individual handlers), and error response shape.

**Fix**: extract to shared utility/helper modules. The rule of thumb is simple: the third time the same logic appears, it gets extracted — not before, to avoid premature abstraction of things that might diverge.

### Undefined service layer

Vibe-coded apps tend to have business logic scattered between route handlers, React components, database queries, and utility files with no principled separation. This makes individual pieces hard to test and makes the same business rule apply differently in different call paths.

**Fix pattern** (progressive — don't force this on a small app all at once):
- **MVP stage**: business logic in route handlers is fine; start here
- **Growth stage**: extract repeated or complex logic into service functions (`src/services/orders.ts`, `src/services/billing.ts`) called by route handlers; route handlers become thin (validate → call service → respond)
- **Scale stage**: services become testable in isolation (no HTTP, no test server needed); integration tests verify the actual HTTP behavior

### Missing error handling

AI-generated code usually handles the happy path correctly. Errors are handled inconsistently or not at all — a `Promise` that rejects silently, a `try/catch` that swallows the error, a 500 response with a stack trace to the client.

**Check**:
```bash
# promise chains with no .catch()
grep -rn "\.then(" --include="*.ts" --include="*.js" . | grep -v "\.catch\|try\|node_modules"

# async functions with no try/catch in route handlers
grep -rn "async.*req.*res\|async.*handler" --include="*.ts" --include="*.js" . -A 20 | grep -c "try {" 
```

**Fix**: wrap every async route handler in a consistent error-catching wrapper rather than repeating `try/catch` in every handler:
```javascript
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

router.get('/api/orders', asyncHandler(async (req, res) => {
  const orders = await db.order.findMany({ where: { userId: req.user.id } });
  res.json(orders);
}));

// global error handler catches anything not explicitly handled
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.statusCode ?? 500).json({ error: err.message ?? 'Internal server error' });
});
```

### Technical debt prevention for ongoing vibe-coded development

One-time hardening is undone by the next AI-coding session. The following are low-cost guardrails that make ongoing AI-assisted development less likely to reintroduce the same problems:

1. **`CLAUDE.md` / `AGENTS.md` in the project root** — add explicit security and architecture rules that AI coding tools read on every session:
   ```markdown
   - Never store secrets in code; use environment variables
   - Every database query against user data must filter by the authenticated user's ID
   - All API routes must call requireAuth() middleware before handling the request
   - Do not use AsyncStorage for tokens; use expo-secure-store
   ```

2. **CI/CD with basic checks** — even a simple GitHub Actions workflow that runs `npm audit`, a linter, and `git secrets --scan` on every push catches the most common regressions before they land in production.

3. **Database migration workflow** — if it doesn't already exist, set one up now and make it the only sanctioned way to change the schema. Schema changes applied by hand, outside migrations, are the fastest path to data loss during a redeploy.

4. **Short periodic stabilization cycles** — every 4-6 sprints, schedule a session focused on refactoring (consolidating duplicated logic, extracting god functions, aligning naming) rather than feature development. This is what prevents the 90-day reckoning where the codebase becomes too tangled to change without breaking things.
