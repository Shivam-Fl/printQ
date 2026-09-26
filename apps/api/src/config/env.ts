import { loadEnvFile } from 'node:process';
import { z } from 'zod';

/** `z.coerce.boolean()` treats every non-empty string (including "false") as
 * true. Environment variables are strings, so parse their literal values. */
const envBoolean = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return value;
}, z.boolean());

/** Empty deployment fields are absent, not malformed credentials. */
const optionalSecret = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  schema.optional(),
);

// Load ./.env when present (dev convenience); production uses real env vars.
try {
  loadEnvFile();
} catch {
  /* no .env file — fine */
}

/**
 * Fail-fast env validation: the process refuses to boot with missing or
 * malformed configuration instead of failing at first use in production.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // This durable identity is intentionally separate from NODE_ENV. It is used
  // in database-name, queue and storage isolation checks so a deployment
  // cannot accidentally attach development resources to production code.
  PRINTQ_ENVIRONMENT: z.enum(['development', 'test', 'production']).optional(),
  PORT: z.coerce.number().int().default(4000),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean)),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
  GEOCODING_BASE_URL: z.string().url().default('https://nominatim.openstreetmap.org'),

  DATABASE_URL: z.string().min(1),
  DATABASE_NAMESPACE: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,48}$/).optional(),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  QUEUE_NAMESPACE: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/).optional(),
  // `all` preserves local/legacy operation. Cloud Run deploys conversion and
  // maintenance as separate worker pools so conversion crashes stay isolated.
  WORKER_ROLE: z.enum(['all', 'conversion', 'maintenance']).default('all'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  OTP_PEPPER: z.string().min(16, 'OTP_PEPPER must be at least 16 chars'),

  // Firebase sends/verifies the student's phone OTP in production. After the
  // Firebase ID token is verified, PrintQ still issues its own scoped JWT so
  // the rest of the platform remains independent of Firebase.
  STUDENT_AUTH_PROVIDER: z.enum(['local', 'firebase']).default('local'),
  FIREBASE_AUTH_API_KEY: z.string().optional(),
  FIREBASE_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/).optional(),
  // Start in monitor mode to measure legitimate web traffic before rejecting
  // unattested requests. Firebase Admin uses Cloud Run ADC, never JSON keys.
  FIREBASE_APP_CHECK_MODE: z.enum(['disabled', 'monitor', 'enforce']).default('disabled'),
  // Firestore is a rebuildable delivery target; PostgreSQL remains the source
  // of truth and the maintenance worker drains its transactional outbox.
  FIREBASE_PROJECTIONS_ENABLED: envBoolean.default(false),
  // FCM uses the same Cloud Run application-default identity as App Check and
  // Firestore. It is intentionally off until the isolated Firebase project,
  // Web Push certificate and delivery QA are ready.
  FIREBASE_FCM_ENABLED: envBoolean.default(false),

  STORAGE_DRIVER: z.enum(['local', 's3', 'gcs']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  // GCS uses the attached Cloud Run service identity through ADC. Do not add
  // a service-account JSON or HMAC key to application configuration.
  GCS_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: envBoolean.default(true),
  STORAGE_NAMESPACE: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/).optional(),

  // A real Windows spooler normally acknowledges acceptance, not physical
  // output. Only the deterministic simulator may auto-complete a job, and
  // never in production. Real jobs require the authenticated staff action.
  ALLOW_SIMULATED_PRINT_COMPLETION: envBoolean.default(false),

  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  PLATFORM_MARKUP_BPS: z.coerce.number().int().min(0).max(10_000).default(2_500),
  SHOP_PAYOUT_PROVIDER: z.enum(['mock', 'razorpay_route']).default('mock'),
  MIN_SHOP_PAYOUT_PAISE: z.coerce.number().int().min(100).default(50_000),
  // Cash remains available while the shop's completed + in-flight settlement
  // exposure stays within this credit limit. ₹500 by default.
  MAX_SHOP_CASH_DEBT_PAISE: z.coerce.number().int().min(100).default(50_000),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Shop commission collection is isolated from the retired student-payment
  // configuration. `test` can only be used outside production; `live` stays
  // disabled until the final explicit cutover confirmation and use-case approval.
  SHOP_COLLECTION_MODE: z.enum(['disabled', 'test', 'live']).default('disabled'),
  SHOP_COLLECTION_PILOT_CAP_PAISE: z.coerce.number().int().min(100).max(1_500_000).default(1_500_000),
  RAZORPAY_RECURRING_WEBHOOK_SECRET: z.string().optional(),

  // Student login OTPs happen pre-session, so they can't be in-app — an SMS
  // provider is required for a real launch (console just logs to the API).
  SMS_PROVIDER: z.enum(['console', 'msg91']).default('console'),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_SENDER_ID: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),

  // Shop-owner forgot-password codes — email delivery, same pluggable pattern
  // (REST API, no SDK — same style as the Razorpay/MSG91 providers above).
  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().min(20).optional(),
  // Header injection is never valid. A display-name plus verified address is
  // allowed because Resend supports it, so do not over-constrain its format.
  EMAIL_FROM: z.string().min(3).max(320).regex(/^[^\r\n]+$/).optional(),

  // The first platform administrator is inserted idempotently at API boot
  // from an argon2id hash. This is a deployment secret, never a browser value
  // and never a plaintext password or service-account credential.
  ADMIN_BOOTSTRAP_EMAIL: optionalSecret(z.string().trim().toLowerCase().email().max(254)),
  ADMIN_BOOTSTRAP_PASSWORD_HASH: optionalSecret(z.string().min(40).regex(/^\$argon2(?:id|i|d)\$/)),

  // Web Push (PWA notifications). Generate once: npx web-push generate-vapid-keys
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@printq.local'),

  OTP_WINDOW_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  NO_SHOW_GRACE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
  // Unprinted uploads have a hard 24-hour maximum. Successful and terminal
  // jobs use the fixed, event-based ten-minute deadline in fileRetention.ts.
  FILE_UNPRINTED_RETENTION_MINUTES: z.coerce.number().int().min(1).max(1_440).default(1_440),
  /// Paid orders that never arrive are refunded and closed after this window.
  PREPARED_ORDER_TTL_HOURS: z.coerce.number().int().min(24).max(720).default(168),
  /// "almost your turn" alert when this many people (or fewer) are ahead
  NEAR_FRONT_THRESHOLD: z.coerce.number().int().min(1).max(20).default(5),
  /// scheduled jobs become eligible this many minutes before their slot
  SCHEDULE_LEAD_MINUTES: z.coerce.number().int().min(0).max(60).default(10),

  SOFFICE_PATH: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const expectedEnvironment = parsed.data.NODE_ENV === 'production'
  ? 'production'
  : parsed.data.NODE_ENV === 'test'
    ? 'test'
    : 'development';
const printqEnvironment = parsed.data.PRINTQ_ENVIRONMENT ?? expectedEnvironment;
const databaseNamespace = parsed.data.DATABASE_NAMESPACE ?? printqEnvironment;
const queueNamespace = parsed.data.QUEUE_NAMESPACE ?? `printq-${printqEnvironment}`;
const storageNamespace = parsed.data.STORAGE_NAMESPACE ?? `printq-${printqEnvironment}`;

export const env = {
  ...parsed.data,
  PRINTQ_ENVIRONMENT: printqEnvironment,
  DATABASE_NAMESPACE: databaseNamespace,
  QUEUE_NAMESPACE: queueNamespace,
  STORAGE_NAMESPACE: storageNamespace,
};

// Cross-field requirements that zod's per-field schema can't express cleanly.
if (env.PAYMENT_PROVIDER === 'razorpay') {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_WEBHOOK_SECRET) {
    // eslint-disable-next-line no-console
    console.error('PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET');
    process.exit(1);
  }
}
if (env.SHOP_PAYOUT_PROVIDER === 'razorpay_route') {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    // eslint-disable-next-line no-console
    console.error('SHOP_PAYOUT_PROVIDER=razorpay_route requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
    process.exit(1);
  }
}
if (env.SHOP_COLLECTION_MODE === 'test' && env.PRINTQ_ENVIRONMENT === 'production') {
  // eslint-disable-next-line no-console
  console.error('SHOP_COLLECTION_MODE=test is prohibited in the production environment');
  process.exit(1);
}
if (env.SHOP_COLLECTION_MODE === 'live') {
  // There is intentionally no source-controlled switch for live recurring
  // money movement. This fail-closed guard remains until a separately audited
  // cutover deployment implements the user-confirmed provider adapter.
  // eslint-disable-next-line no-console
  console.error('SHOP_COLLECTION_MODE=live is not enabled by this release');
  process.exit(1);
}
if (env.STUDENT_AUTH_PROVIDER === 'firebase' && !env.FIREBASE_AUTH_API_KEY) {
  // eslint-disable-next-line no-console
  console.error('STUDENT_AUTH_PROVIDER=firebase requires FIREBASE_AUTH_API_KEY');
  process.exit(1);
}
if (env.STUDENT_AUTH_PROVIDER === 'firebase' && !env.FIREBASE_PROJECT_ID) {
  // eslint-disable-next-line no-console
  console.error('STUDENT_AUTH_PROVIDER=firebase requires FIREBASE_PROJECT_ID');
  process.exit(1);
}
if (env.FIREBASE_APP_CHECK_MODE !== 'disabled' && !env.FIREBASE_PROJECT_ID) {
  // eslint-disable-next-line no-console
  console.error('FIREBASE_APP_CHECK_MODE requires FIREBASE_PROJECT_ID');
  process.exit(1);
}
if (env.FIREBASE_PROJECTIONS_ENABLED && !env.FIREBASE_PROJECT_ID) {
  // eslint-disable-next-line no-console
  console.error('FIREBASE_PROJECTIONS_ENABLED requires FIREBASE_PROJECT_ID');
  process.exit(1);
}
if (env.FIREBASE_FCM_ENABLED && !env.FIREBASE_PROJECT_ID) {
  // eslint-disable-next-line no-console
  console.error('FIREBASE_FCM_ENABLED requires FIREBASE_PROJECT_ID');
  process.exit(1);
}
if (env.SMS_PROVIDER === 'msg91') {
  if (!env.MSG91_AUTH_KEY || !env.MSG91_SENDER_ID || !env.MSG91_TEMPLATE_ID) {
    // eslint-disable-next-line no-console
    console.error('SMS_PROVIDER=msg91 requires MSG91_AUTH_KEY, MSG91_SENDER_ID and MSG91_TEMPLATE_ID');
    process.exit(1);
  }
}
if (env.EMAIL_PROVIDER === 'resend') {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    // eslint-disable-next-line no-console
    console.error('EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM');
    process.exit(1);
  }
}
if (env.NODE_ENV === 'production' && env.EMAIL_PROVIDER !== 'resend') {
  // A console reset provider is useful only for isolated local tests. A real
  // shop owner must receive a password reset through a verified sender.
  // eslint-disable-next-line no-console
  console.error('Production requires EMAIL_PROVIDER=resend');
  process.exit(1);
}
if (env.NODE_ENV === 'production' && (!env.ADMIN_BOOTSTRAP_EMAIL || !env.ADMIN_BOOTSTRAP_PASSWORD_HASH)) {
  // Production must have a separately authenticated platform administrator
  // before a shop can be verified or published.
  // eslint-disable-next-line no-console
  console.error('Production requires ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD_HASH');
  process.exit(1);
}
if ((env.VAPID_PUBLIC_KEY && !env.VAPID_PRIVATE_KEY) || (!env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY)) {
  // eslint-disable-next-line no-console
  console.error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together');
  process.exit(1);
}
if (env.STORAGE_DRIVER === 's3') {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    // eslint-disable-next-line no-console
    console.error('STORAGE_DRIVER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
    process.exit(1);
  }
}
if (env.STORAGE_DRIVER === 'gcs' && !env.GCS_BUCKET) {
  // eslint-disable-next-line no-console
  console.error('STORAGE_DRIVER=gcs requires GCS_BUCKET');
  process.exit(1);
}
if (env.STORAGE_DRIVER === 's3' || env.STORAGE_DRIVER === 'gcs') {
  const bucket = env.STORAGE_DRIVER === 's3' ? env.S3_BUCKET! : env.GCS_BUCKET!;
  if (!bucket.toLowerCase().includes(env.PRINTQ_ENVIRONMENT)) {
    // A namespace inside a shared bucket is insufficient isolation. Require
    // the backing bucket identity itself to declare its environment.
    // eslint-disable-next-line no-console
    console.error(`${env.STORAGE_DRIVER} bucket must include PRINTQ_ENVIRONMENT`);
    process.exit(1);
  }
}
if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.some((o) => o === '*')) {
  // eslint-disable-next-line no-console
  console.error('Wildcard CORS origin is not allowed in production');
  process.exit(1);
}
if (env.NODE_ENV === 'production' && env.ALLOW_SIMULATED_PRINT_COMPLETION) {
  // eslint-disable-next-line no-console
  console.error('ALLOW_SIMULATED_PRINT_COMPLETION cannot be enabled in production');
  process.exit(1);
}
if (env.PRINTQ_ENVIRONMENT !== expectedEnvironment) {
  // eslint-disable-next-line no-console
  console.error(`PRINTQ_ENVIRONMENT=${env.PRINTQ_ENVIRONMENT} is incompatible with NODE_ENV=${env.NODE_ENV}`);
  process.exit(1);
}
const isLiveRazorpayKey = env.RAZORPAY_KEY_ID?.startsWith('rzp_live_') ?? false;
const isTestRazorpayKey = env.RAZORPAY_KEY_ID?.startsWith('rzp_test_') ?? false;
if (env.PRINTQ_ENVIRONMENT === 'development' && isLiveRazorpayKey) {
  // eslint-disable-next-line no-console
  console.error('Development cannot use a live Razorpay key');
  process.exit(1);
}
if (env.PRINTQ_ENVIRONMENT === 'production' && isTestRazorpayKey) {
  // eslint-disable-next-line no-console
  console.error('Production cannot use a Razorpay TEST key');
  process.exit(1);
}
if (env.STUDENT_AUTH_PROVIDER === 'firebase') {
  const project = env.FIREBASE_PROJECT_ID!.toLowerCase();
  if (env.PRINTQ_ENVIRONMENT === 'development' && /prod(uction)?/.test(project)) {
    // eslint-disable-next-line no-console
    console.error('Development cannot use a production Firebase project');
    process.exit(1);
  }
  if (env.PRINTQ_ENVIRONMENT === 'production' && /(dev(elopment)?|test)/.test(project)) {
    // eslint-disable-next-line no-console
    console.error('Production cannot use a development or test Firebase project');
    process.exit(1);
  }
}
const knownProductionOrigins = new Set(['https://printqs.com', 'https://www.printqs.com', 'https://api.printqs.com']);
if (env.PRINTQ_ENVIRONMENT === 'development' && env.CORS_ORIGINS.some((origin) => knownProductionOrigins.has(origin))) {
  // eslint-disable-next-line no-console
  console.error('Development CORS cannot trust a production PrintQs origin');
  process.exit(1);
}
if (env.PRINTQ_ENVIRONMENT === 'production' && env.CORS_ORIGINS.some((origin) => {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'localhost'
    || host === '127.0.0.1'
    || /(^|[.-])(?:dev|development)(?=[.-]|$)/.test(host);
})) {
  // eslint-disable-next-line no-console
  console.error('Production CORS cannot trust a development origin');
  process.exit(1);
}
try {
  const databaseName = new URL(env.DATABASE_URL).pathname.replace(/^\//, '').toLowerCase();
  if (!databaseName.includes(env.DATABASE_NAMESPACE.toLowerCase())) {
    // eslint-disable-next-line no-console
    console.error('DATABASE_URL database name must include DATABASE_NAMESPACE');
    process.exit(1);
  }
} catch {
  // zod only verifies a non-empty URL because Prisma permits several database
  // URL shapes. For Postgres deployments we still need a parseable namespace.
  // eslint-disable-next-line no-console
  console.error('DATABASE_URL must be a valid URL with an environment-specific database name');
  process.exit(1);
}
if (env.NODE_ENV === 'production' && env.STORAGE_DRIVER !== 's3' && env.STORAGE_DRIVER !== 'gcs') {
  // eslint-disable-next-line no-console
  console.error('Production requires private durable S3-compatible or Google Cloud Storage');
  process.exit(1);
}
