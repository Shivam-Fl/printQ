import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearShopSessionNotice, noteShopSessionEnded, SESSION_ENDED_NOTICE, takeShopSessionNotice, tokenExpiry, wasRevoked,
} from './shopSessionNotice.js';

/** An unsigned JWT-shaped token: the web only reads `exp`, the server checks the signature. */
function token(claims: Record<string, unknown>): string {
  const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.signature`;
}

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const inAnHour = Math.floor(NOW / 1000) + 3600;
const anHourAgo = Math.floor(NOW / 1000) - 3600;

beforeEach(() => clearShopSessionNotice());

describe('tokenExpiry', () => {
  it('reads exp from a JWT payload', () => {
    expect(tokenExpiry(token({ typ: 'shop', exp: inAnHour }))).toBe(inAnHour);
  });
  it('returns null for anything that is not a readable JWT', () => {
    expect(tokenExpiry(null)).toBeNull();
    expect(tokenExpiry('')).toBeNull();
    expect(tokenExpiry('not-a-token')).toBeNull();
    expect(tokenExpiry('a.%%%.c')).toBeNull();
    expect(tokenExpiry(token({ typ: 'shop' }))).toBeNull();
  });
});

describe('revoked vs expired', () => {
  it('a 401 for an unexpired token means it was revoked', () => {
    expect(wasRevoked(token({ exp: inAnHour }), NOW)).toBe(true);
  });
  it('a 401 for an expired token is a normal time-out', () => {
    expect(wasRevoked(token({ exp: anHourAgo }), NOW)).toBe(false);
    expect(wasRevoked(null, NOW)).toBe(false);
  });
});

describe('one-time notice (PSLS-1)', () => {
  it('shows once after a revoked session, then never again', () => {
    noteShopSessionEnded(token({ exp: inAnHour }), NOW);
    expect(takeShopSessionNotice()).toBe(SESSION_ENDED_NOTICE);
    expect(SESSION_ENDED_NOTICE).toBe('You were signed out because your password was changed or you signed out on another device.');
    expect(takeShopSessionNotice()).toBeNull();
  });
  it('says nothing when the session simply expired', () => {
    noteShopSessionEnded(token({ exp: anHourAgo }), NOW);
    expect(takeShopSessionNotice()).toBeNull();
  });
  it('a sign-out on this device clears it', () => {
    noteShopSessionEnded(token({ exp: inAnHour }), NOW);
    clearShopSessionNotice();
    expect(takeShopSessionNotice()).toBeNull();
  });
});
