import { loadEnvFile } from 'node:process';
import { z } from 'zod';

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
  PORT: z.coerce.number().int().default(4000),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean)),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
  GEOCODING_BASE_URL: z.string().url().default('https://nominatim.openstreetmap.org'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  OTP_PEPPER: z.string().min(16, 'OTP_PEPPER must be at least 16 chars'),

  // Firebase sends/verifies the student's phone OTP in production. After the
  // Firebase ID token is verified, PrintQ still issues its own scoped JWT so
  // the rest of the platform remains independent of Firebase.
  STUDENT_AUTH_PROVIDER: z.enum(['local', 'firebase']).default('local'),
  FIREBASE_AUTH_API_KEY: z.string().optional(),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

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
  FILE_RETENTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
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

export const env = parsed.data;

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
