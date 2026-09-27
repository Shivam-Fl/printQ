import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Creates the separately authenticated platform-admin identity exactly once.
 * The owner may supply an argon2id hash through the deployment secret store.
 * Otherwise the first password is random and never disclosed; the owner sets a
 * usable password through the separately rate-limited, emailed recovery flow.
 * No bootstrap endpoint, plaintext password, or browser-visible secret exists.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  if (!env.ADMIN_BOOTSTRAP_EMAIL) return;

  const existing = await prisma.adminUser.findUnique({ where: { email: env.ADMIN_BOOTSTRAP_EMAIL } });
  if (existing) return;

  const passwordHash = env.ADMIN_BOOTSTRAP_PASSWORD_HASH
    ?? await argon2.hash(randomBytes(48).toString('base64url'), { type: argon2.argon2id });
  await prisma.adminUser.upsert({
    where: { email: env.ADMIN_BOOTSTRAP_EMAIL },
    update: {},
    create: {
      email: env.ADMIN_BOOTSTRAP_EMAIL,
      passwordHash,
      name: 'Platform Administrator',
      role: 'platform_admin',
    },
  });
  logger.info('platform_admin_bootstrapped');
}
