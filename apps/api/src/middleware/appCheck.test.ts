import { describe, expect, it, vi } from 'vitest';
import { assessAppCheck } from './appCheck.js';

describe('Firebase App Check policy', () => {
  it('permits monitor-mode requests but never treats a missing assertion as verified', async () => {
    await expect(assessAppCheck('monitor', undefined)).resolves.toEqual({ accepted: true });
  });

  it('rejects missing and invalid assertions when enforcement is enabled', async () => {
    await expect(assessAppCheck('enforce', undefined)).resolves.toEqual({ accepted: false, reason: 'missing' });
    await expect(assessAppCheck('enforce', 'bad-token', vi.fn().mockRejectedValue(new Error('invalid'))))
      .resolves.toEqual({ accepted: false, reason: 'invalid' });
  });

  it('accepts a server-verified assertion and exposes only its app id', async () => {
    await expect(assessAppCheck('enforce', 'token', vi.fn().mockResolvedValue({ appId: '1:123:web:abc' })))
      .resolves.toEqual({ accepted: true, appId: '1:123:web:abc' });
  });
});
