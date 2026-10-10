import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(process.cwd(), '../..');
const configPath = path.join(root, 'apps', 'api', 'src', 'config', 'env.ts');

function loadConfig(overrides: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', configPath], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PRINTQ_ENVIRONMENT: 'development',
      DATABASE_URL: 'postgresql://printq:printq@127.0.0.1:5432/printq_development',
      DATABASE_NAMESPACE: 'development',
      REDIS_URL: 'redis://127.0.0.1:6379/15',
      QUEUE_NAMESPACE: 'printq-development',
      STORAGE_NAMESPACE: 'printq-development',
      JWT_SECRET: 'x'.repeat(48),
      OTP_PEPPER: 'y'.repeat(32),
      PAYMENT_PROVIDER: 'mock',
      SHOP_PAYOUT_PROVIDER: 'mock',
      STUDENT_AUTH_PROVIDER: 'local',
      STORAGE_DRIVER: 'local',
      ALLOW_SIMULATED_PRINT_COMPLETION: 'false',
      SMS_PROVIDER: 'console',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 'resend-test-key-that-is-long-enough',
      EMAIL_FROM: 'PrintQs <security@printqs.test>',
      ADMIN_BOOTSTRAP_EMAIL: 'admin@printqs.test',
      ADMIN_BOOTSTRAP_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      CORS_ORIGINS: 'http://localhost:5173',
      ...overrides,
    },
  });
}

describe('environment isolation contract', () => {
  it('accepts matching development identities and namespaced resources', () => {
    expect(loadConfig({}).status).toBe(0);
  });

  it('rejects a live Razorpay key in development', () => {
    const result = loadConfig({ RAZORPAY_KEY_ID: 'rzp_live_placeholder' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Development cannot use a live Razorpay key');
  });

  it('rejects a Razorpay TEST key in production', () => {
    const result = loadConfig({
      NODE_ENV: 'production',
      PRINTQ_ENVIRONMENT: 'production',
      DATABASE_URL: 'postgresql://printq:printq@127.0.0.1:5432/printq_production',
      DATABASE_NAMESPACE: 'production',
      QUEUE_NAMESPACE: 'printq-production',
      STORAGE_NAMESPACE: 'printq-production',
      CORS_ORIGINS: 'https://api.example.test',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'printq-production-test-fixture',
      S3_ACCESS_KEY_ID: 'test-access-key',
      S3_SECRET_ACCESS_KEY: 'test-secret-key',
      RAZORPAY_KEY_ID: 'rzp_test_placeholder',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Production cannot use a Razorpay TEST key');
  });

  const PROD = {
    NODE_ENV: 'production',
    PRINTQ_ENVIRONMENT: 'production',
    DATABASE_URL: 'postgresql://printq:printq@127.0.0.1:5432/printq_production',
    DATABASE_NAMESPACE: 'production',
    QUEUE_NAMESPACE: 'printq-production',
    STORAGE_NAMESPACE: 'printq-production',
    CORS_ORIGINS: 'https://api.example.test',
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'printq-production-test-fixture',
    S3_ACCESS_KEY_ID: 'test-access-key',
    S3_SECRET_ACCESS_KEY: 'test-secret-key',
  };
  const FEE_RAZORPAY = {
    FEE_PAYMENT_PROVIDER: 'razorpay',
    RAZORPAY_KEY_SECRET: 'secret-placeholder',
    RAZORPAY_WEBHOOK_SECRET: 'whsec-placeholder',
  };

  it('defaults shop fee payments to disabled and allows mock only outside production', () => {
    expect(loadConfig({}).status).toBe(0);
    expect(loadConfig({ FEE_PAYMENT_PROVIDER: 'mock' }).status).toBe(0);
    const result = loadConfig({ ...PROD, FEE_PAYMENT_PROVIDER: 'mock' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FEE_PAYMENT_PROVIDER=mock is prohibited in the production environment');
  });

  it('requires Razorpay credentials for the razorpay fee provider', () => {
    const result = loadConfig({ FEE_PAYMENT_PROVIDER: 'razorpay' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FEE_PAYMENT_PROVIDER=razorpay requires');
    expect(loadConfig({ ...FEE_RAZORPAY, RAZORPAY_KEY_ID: 'rzp_test_placeholder' }).status).toBe(0);
  });

  it('accepts only live keys for production fee payments and refuses TEST keys', () => {
    expect(loadConfig({ ...PROD, ...FEE_RAZORPAY, RAZORPAY_KEY_ID: 'rzp_live_placeholder' }).status).toBe(0);
    const testKey = loadConfig({ ...PROD, ...FEE_RAZORPAY, RAZORPAY_KEY_ID: 'rzp_test_placeholder' });
    expect(testKey.status).toBe(1);
    expect(testKey.stderr).toContain('Production fee payments require a Razorpay live key');
    expect(loadConfig({ ...PROD, ...FEE_RAZORPAY, RAZORPAY_KEY_ID: 'rzp_test_placeholder' }).stderr)
      .toContain('live key');
  });

  it('refuses live keys outside production unless explicitly allowed', () => {
    const refused = loadConfig({ ...FEE_RAZORPAY, RAZORPAY_KEY_ID: 'rzp_live_placeholder' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('cannot use a live Razorpay key');
    expect(loadConfig({
      ...FEE_RAZORPAY,
      RAZORPAY_KEY_ID: 'rzp_live_placeholder',
      ALLOW_LIVE_RAZORPAY_KEYS_OUTSIDE_PRODUCTION: 'true',
    }).status).toBe(0);
  });

  it('bounds the fee payment terms configuration', () => {
    expect(loadConfig({ FEE_PAYMENT_TERMS_DAYS: '0' }).status).toBe(1);
    expect(loadConfig({ FEE_PAYMENT_TERMS_DAYS: '14', FEE_OVERDUE_BLOCK_AFTER_DAYS: '2' }).status).toBe(0);
  });

  it('parses a literal false simulator flag as false in production', () => {
    const result = loadConfig({
      NODE_ENV: 'production',
      PRINTQ_ENVIRONMENT: 'production',
      DATABASE_URL: 'postgresql://printq:printq@127.0.0.1:5432/printq_production',
      DATABASE_NAMESPACE: 'production',
      QUEUE_NAMESPACE: 'printq-production',
      STORAGE_NAMESPACE: 'printq-production',
      CORS_ORIGINS: 'https://api.example.test',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'printq-production-test-fixture',
      S3_ACCESS_KEY_ID: 'test-access-key',
      S3_SECRET_ACCESS_KEY: 'test-secret-key',
      ALLOW_SIMULATED_PRINT_COMPLETION: 'false',
    });
    expect(result.status).toBe(0);
  });

  it('requires a separately bootstrapped platform administrator in production', () => {
    const result = loadConfig({
      NODE_ENV: 'production',
      PRINTQ_ENVIRONMENT: 'production',
      DATABASE_URL: 'postgresql://printq:printq@127.0.0.1:5432/printq_production',
      DATABASE_NAMESPACE: 'production',
      QUEUE_NAMESPACE: 'printq-production',
      STORAGE_NAMESPACE: 'printq-production',
      CORS_ORIGINS: 'https://api.example.test',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'printq-production-test-fixture',
      S3_ACCESS_KEY_ID: 'test-access-key',
      S3_SECRET_ACCESS_KEY: 'test-secret-key',
      ADMIN_BOOTSTRAP_EMAIL: '',
      ADMIN_BOOTSTRAP_PASSWORD_HASH: '',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Production requires ADMIN_BOOTSTRAP_EMAIL');
  });

  it('accepts email-only admin bootstrap when production email recovery is enabled', () => {
    const result = loadConfig({
      NODE_ENV: 'production',
      PRINTQ_ENVIRONMENT: 'production',
      DATABASE_URL: 'postgresql://printq:printq@127.0.0.1:5432/printq_production',
      DATABASE_NAMESPACE: 'production',
      QUEUE_NAMESPACE: 'printq-production',
      STORAGE_NAMESPACE: 'printq-production',
      CORS_ORIGINS: 'https://api.example.test',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'printq-production-test-fixture',
      S3_ACCESS_KEY_ID: 'test-access-key',
      S3_SECRET_ACCESS_KEY: 'test-secret-key',
      ADMIN_BOOTSTRAP_PASSWORD_HASH: '',
    });
    expect(result.status).toBe(0);
  });

  it('rejects a production Firebase project in development', () => {
    const result = loadConfig({
      STUDENT_AUTH_PROVIDER: 'firebase',
      FIREBASE_AUTH_API_KEY: 'test-browser-key',
      FIREBASE_PROJECT_ID: 'printqs-production',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Development cannot use a production Firebase project');
  });

  it('rejects production web origins in development', () => {
    const result = loadConfig({ CORS_ORIGINS: 'https://printqs.com' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Development CORS cannot trust a production PrintQs origin');
  });

  it('rejects development web origins in production', () => {
    for (const origin of ['https://development.printqs.com', 'https://printqs-development.web.app']) {
      const result = loadConfig({
        NODE_ENV: 'production',
        PRINTQ_ENVIRONMENT: 'production',
        DATABASE_URL: 'postgresql://printq:printq@127.0.0.1:5432/printq_production',
        DATABASE_NAMESPACE: 'production',
        QUEUE_NAMESPACE: 'printq-production',
        STORAGE_NAMESPACE: 'printq-production',
        CORS_ORIGINS: origin,
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'printq-production-test-fixture',
        S3_ACCESS_KEY_ID: 'test-access-key',
        S3_SECRET_ACCESS_KEY: 'test-secret-key',
      });
      expect(result.status, origin).toBe(1);
      expect(result.stderr, origin).toContain('Production CORS cannot trust a development origin');
    }
  });

  it('requires a Firebase project before App Check can be monitored or enforced', () => {
    const result = loadConfig({ FIREBASE_APP_CHECK_MODE: 'monitor' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FIREBASE_APP_CHECK_MODE requires FIREBASE_PROJECT_ID');
  });

  it('requires a Firebase project before realtime projections can be enabled', () => {
    const result = loadConfig({ FIREBASE_PROJECTIONS_ENABLED: 'true' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FIREBASE_PROJECTIONS_ENABLED requires FIREBASE_PROJECT_ID');
  });

  it('requires a Firebase project before FCM delivery can be enabled', () => {
    const result = loadConfig({ FIREBASE_FCM_ENABLED: 'true' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FIREBASE_FCM_ENABLED requires FIREBASE_PROJECT_ID');
  });

  it('rejects the console password-reset provider in production', () => {
    const result = loadConfig({
      NODE_ENV: 'production',
      PRINTQ_ENVIRONMENT: 'production',
      DATABASE_URL: 'postgresql://printq:printq@127.0.0.1:5432/printq_production',
      DATABASE_NAMESPACE: 'production',
      QUEUE_NAMESPACE: 'printq-production',
      STORAGE_NAMESPACE: 'printq-production',
      CORS_ORIGINS: 'https://api.example.test',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'printq-production-test-fixture',
      S3_ACCESS_KEY_ID: 'test-access-key',
      S3_SECRET_ACCESS_KEY: 'test-secret-key',
      EMAIL_PROVIDER: 'console',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Production requires EMAIL_PROVIDER=resend');
  });

  it('rejects an unrecognised worker role before it can start a mixed worker process', () => {
    expect(loadConfig({ WORKER_ROLE: 'everything' }).status).toBe(1);
  });

  it('accepts a namespaced private GCS bucket without static cloud credentials', () => {
    expect(loadConfig({ STORAGE_DRIVER: 'gcs', GCS_BUCKET: 'printqs-development-private' }).status).toBe(0);
  });

  it('requires a bucket when GCS is selected', () => {
    const result = loadConfig({ STORAGE_DRIVER: 'gcs', GCS_BUCKET: '' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('STORAGE_DRIVER=gcs requires GCS_BUCKET');
  });

  it('rejects a GCS bucket that does not declare the active environment', () => {
    const result = loadConfig({ STORAGE_DRIVER: 'gcs', GCS_BUCKET: 'printqs-shared-private' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gcs bucket must include PRINTQ_ENVIRONMENT');
  });
});
