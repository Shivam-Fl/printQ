import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

const required = ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'OTP_PEPPER'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`CI integration environment is missing: ${missing.join(', ')}`);
  process.exitCode = 1;
} else {
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 5_000 });
  try {
    await prisma.$queryRaw`SELECT 1`;
    const pong = await redis.ping();
    if (pong !== 'PONG') throw new Error('Redis did not return PONG');
    console.log('CI PostgreSQL and Redis connectivity verified.');
  } catch (error) {
    console.error(`CI integration environment is unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  }
}
