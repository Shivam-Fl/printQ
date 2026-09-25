import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Creates the separately authenticated platform-admin identity exactly once.
 * The credential is an argon2id hash supplied by the deployment secret store;
 * no bootstrap endpoint, plaintext password, or browser-visible secret exists.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  if (!env.ADMIN_BOOTSTRAP_EMAIL || !env.ADMIN_BOOTSTRAP_PASSWORD_HASH) return;

  const existing = await prisma.adminUser.findUnique({ where: { email: env.ADMIN_BOOTSTRAP_EMAIL } });
  if (existing) return;

  await prisma.adminUser.create({
    data: {
      email: env.ADMIN_BOOTSTRAP_EMAIL,
      passwordHash: env.ADMIN_BOOTSTRAP_PASSWORD_HASH,
      name: 'Platform Administrator',
      role: 'platform_admin',
    },
  });
  logger.info('platform_admin_bootstrapped');
}
