import { afterAll } from 'vitest';

// Every API test receives a safe, explicit test configuration. CI supplies a
// disposable PostgreSQL/Redis pair; these values only make local unit tests
// deterministic when the caller has already supplied those endpoints.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://printq_test:printq_test@127.0.0.1:5432/printq_test';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379/15';
process.env.JWT_SECRET ??= 'test-only-jwt-secret-that-is-at-least-thirty-two-characters';
process.env.OTP_PEPPER ??= 'test-only-otp-pepper-that-is-at-least-sixteen-characters';
process.env.PAYMENT_PROVIDER ??= 'mock';
process.env.SHOP_PAYOUT_PROVIDER ??= 'mock';
process.env.STUDENT_AUTH_PROVIDER ??= 'local';
process.env.STORAGE_DRIVER ??= 'local';
process.env.SMS_PROVIDER ??= 'console';
process.env.EMAIL_PROVIDER ??= 'console';
process.env.ALLOW_SIMULATED_PRINT_COMPLETION ??= 'true';

afterAll(async () => {
  const [{ closeRedis }, { prisma }] = await Promise.all([
    import('../lib/redis.js'),
    import('../lib/prisma.js'),
  ]);
  await Promise.allSettled([closeRedis(), prisma.$disconnect()]);
});
