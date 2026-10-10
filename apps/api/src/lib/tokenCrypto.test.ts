import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ env: { COLLECTION_TOKEN_ENC_KEY: Buffer.alloc(32, 1).toString('base64') } }));
vi.mock('../config/env.js', () => ({ env: state.env }));

import { decryptToken, encryptToken, readStoredToken } from './tokenCrypto.js';

describe('mandate token encryption', () => {
  it('round-trips and never stores plaintext', () => {
    const enc = encryptToken('token_Abc123', 'mandate-1');
    expect(enc).not.toContain('token_Abc123');
    expect(decryptToken(enc, 'mandate-1')).toBe('token_Abc123');
    expect(encryptToken('token_Abc123', 'mandate-1')).not.toBe(enc);
  });
  it('detects tampering, wrong AAD and wrong key', () => {
    const enc = encryptToken('token_Abc123', 'mandate-1');
    const parts = enc.split('.');
    const flipped = parts[3]!.startsWith('A') ? `B${parts[3]!.slice(1)}` : `A${parts[3]!.slice(1)}`;
    expect(() => decryptToken([...parts.slice(0, 3), flipped].join('.'), 'mandate-1')).toThrow('Invalid encrypted token');
    expect(() => decryptToken(enc, 'mandate-2')).toThrow('Invalid encrypted token');
    expect(() => decryptToken('garbage', 'mandate-1')).toThrow('Invalid encrypted token');
    state.env.COLLECTION_TOKEN_ENC_KEY = Buffer.alloc(32, 2).toString('base64');
    expect(() => decryptToken(enc, 'mandate-1')).toThrow('Invalid encrypted token');
    state.env.COLLECTION_TOKEN_ENC_KEY = Buffer.alloc(32, 1).toString('base64');
  });
  it('refuses to run without a valid key', () => {
    state.env.COLLECTION_TOKEN_ENC_KEY = 'c2hvcnQ=';
    expect(() => encryptToken('x', 'a')).toThrow('not configured');
    state.env.COLLECTION_TOKEN_ENC_KEY = Buffer.alloc(32, 1).toString('base64');
  });
  it('reads legacy plaintext rows', () => {
    expect(readStoredToken('token_Legacy1', 'm')).toBe('token_Legacy1');
    expect(readStoredToken(encryptToken('token_New1', 'm'), 'm')).toBe('token_New1');
  });
});
