import { describe, expect, it, vi } from 'vitest';
import { loadEphemeralAgentToken } from './cliToken.js';

describe('loadEphemeralAgentToken', () => {
  it('uses an injected token without prompting', async () => {
    const prompt = vi.fn();
    await expect(loadEphemeralAgentToken('  one-time-token  ', prompt)).resolves.toBe('one-time-token');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('prompts for a token but never returns a persistence instruction', async () => {
    const prompt = vi.fn().mockResolvedValue(' entered-once ');
    await expect(loadEphemeralAgentToken(undefined, prompt)).resolves.toBe('entered-once');
    expect(prompt).toHaveBeenCalledOnce();
  });
});
