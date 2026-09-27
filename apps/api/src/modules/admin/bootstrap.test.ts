import argon2 from 'argon2';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  email: 'owner@example.test' as string | undefined,
  configuredHash: undefined as string | undefined,
  existing: null as null | { email: string; passwordHash: string },
  created: null as null | { email: string; passwordHash: string },
  log: vi.fn(),
}));

vi.mock('../../config/env.js', () => ({ env: {
  get ADMIN_BOOTSTRAP_EMAIL() { return state.email; },
  get ADMIN_BOOTSTRAP_PASSWORD_HASH() { return state.configuredHash; },
} }));
vi.mock('../../lib/logger.js', () => ({ logger: { info: state.log } }));
vi.mock('../../lib/prisma.js', () => ({ prisma: { $disconnect: vi.fn(async () => undefined), adminUser: {
  findUnique: vi.fn(async () => state.existing),
  upsert: vi.fn(async ({ create }: { create: { email: string; passwordHash: string } }) => {
    state.created = create;
    return create;
  }),
} } }));

import { ensureBootstrapAdmin } from './bootstrap.js';

beforeEach(() => {
  state.email = 'owner@example.test';
  state.configuredHash = undefined;
  state.existing = null;
  state.created = null;
  state.log.mockClear();
});

describe('production administrator bootstrap', () => {
  it('creates an email-recoverable admin with an unknown random initial password', async () => {
    await ensureBootstrapAdmin();
    expect(state.created?.email).toBe('owner@example.test');
    expect(state.created?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(state.created!.passwordHash, 'password123456')).toBe(false);
    expect(state.log).toHaveBeenCalledWith('platform_admin_bootstrapped');
  });

  it('does not replace an existing administrator credential', async () => {
    state.existing = { email: 'owner@example.test', passwordHash: 'existing-hash' };
    await ensureBootstrapAdmin();
    expect(state.created).toBeNull();
  });

  it('preserves an explicitly supplied bootstrap hash for existing deployments', async () => {
    state.configuredHash = '$argon2id$deployment-controlled-hash';
    await ensureBootstrapAdmin();
    expect(state.created?.passwordHash).toBe(state.configuredHash);
  });

  it('does not create an administrator without an explicit owner email', async () => {
    state.email = undefined;
    await ensureBootstrapAdmin();
    expect(state.created).toBeNull();
  });
});
