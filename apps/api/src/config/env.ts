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

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
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

  // Student login OTPs happen pre-session, so they can't be in-app — an SMS
  // provider is required for a real launch (console just logs to the API).
  SMS_PROVIDER: z.enum(['console', 'msg91']).default('console'),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_SENDER_ID: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),

  // Shop-owner forgot-password codes — email delivery, same pluggable pattern
  // (REST API, no SDK — same style as the Razorpay/MSG91 providers above).
  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

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
if (env.PRINTQ_ENVIRONMENT === 'production' && env.CORS_ORIGINS.some((origin) => /localhost|127\.0\.0\.1/i.test(origin))) {
  // eslint-disable-next-line no-console
  console.error('Production CORS cannot trust a localhost origin');
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
if (env.NODE_ENV === 'production' && env.STORAGE_DRIVER !== 's3') {
  // eslint-disable-next-line no-console
  console.error('Production requires private durable S3-compatible object storage');
  process.exit(1);
}
