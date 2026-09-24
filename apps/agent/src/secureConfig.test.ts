import { describe, expect, it } from 'vitest';
import { fromStoredDesktopConfig, toStoredDesktopConfig, type SecureStorage } from './secureConfig.js';

const secureStorage: SecureStorage = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
};

describe('desktop secure configuration', () => {
  it('persists an encrypted token without a plaintext fallback', () => {
    const stored = toStoredDesktopConfig({
      apiUrl: 'https://api.development.printqs.example/',
      webUrl: 'https://development.printqs.example/',
      token: 'agent-token-that-must-never-be-plain-text',
      mode: 'real',
    }, secureStorage);

    expect(stored).not.toHaveProperty('token');
    expect(JSON.stringify(stored)).not.toContain('agent-token-that-must-never-be-plain-text');
    expect(fromStoredDesktopConfig(stored, secureStorage)).toMatchObject({
      apiUrl: 'https://api.development.printqs.example',
      webUrl: 'https://development.printqs.example',
      mode: 'real',
    });
  });

  it('rejects a legacy plaintext token instead of silently using it', () => {
    expect(fromStoredDesktopConfig({
      apiUrl: 'https://api.development.printqs.example',
      token: 'legacy-plaintext-token',
    }, secureStorage)).toBeNull();
  });

  it('fails closed when Windows secure storage is unavailable', () => {
    const unavailable: SecureStorage = { ...secureStorage, isAvailable: () => false };
    expect(() => toStoredDesktopConfig({
      apiUrl: 'https://api.development.printqs.example',
      webUrl: 'https://development.printqs.example',
      token: 'agent-token-that-must-not-be-written',
      mode: 'real',
    }, unavailable)).toThrow('secure storage');
  });
});
