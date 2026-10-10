import { describe, expect, it } from 'vitest';
import { parseTrustProxy, resolveClientIp } from './clientIp.js';

const cf = parseTrustProxy('cloudflare');
const CLIENT = '49.36.10.20';
const EDGE = '172.69.100.5'; // inside 172.64.0.0/13
const RENDER = '10.20.30.40'; // private Render proxy

describe('parseTrustProxy', () => {
  it('parses hop counts, modes and rejects junk', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('none')).toBe(false);
    expect(Array.isArray(parseTrustProxy('cloudflare'))).toBe(true);
    expect(() => parseTrustProxy('lots')).toThrow();
  });
});

describe('cloudflare mode', () => {
  it('resolves the real client behind Cloudflare + Render regardless of which edge IP was used', () => {
    for (const edge of ['172.69.100.5', '104.23.1.9', '162.159.200.1']) {
      expect(resolveClientIp(cf, RENDER, { 'x-forwarded-for': `${CLIENT}, ${edge}` })).toBe(CLIENT);
    }
  });

  it('works when Render appends its own private hop too', () => {
    expect(resolveClientIp(cf, RENDER, { 'x-forwarded-for': `${CLIENT}, ${EDGE}, 10.1.1.1` })).toBe(CLIENT);
  });

  it('ignores a client-supplied X-Forwarded-For prefix (attacker cannot rotate identity)', () => {
    const a = resolveClientIp(cf, RENDER, { 'x-forwarded-for': `1.1.1.1, ${CLIENT}, ${EDGE}` });
    const b = resolveClientIp(cf, RENDER, { 'x-forwarded-for': `9.9.9.9, 8.8.8.8, ${CLIENT}, ${EDGE}` });
    expect(a).toBe(CLIENT);
    expect(b).toBe(CLIENT);
  });

  it('ignores CF-Connecting-IP and True-Client-IP entirely', () => {
    const ip = resolveClientIp(cf, RENDER, {
      'x-forwarded-for': `${CLIENT}, ${EDGE}`,
      'cf-connecting-ip': '6.6.6.6',
      'true-client-ip': '7.7.7.7',
    });
    expect(ip).toBe(CLIENT);
  });

  it('request that bypasses Cloudflare resolves to the connecting address, not spoofed headers', () => {
    // Attacker hits the origin directly: the Render proxy appends the attacker's real IP.
    const ip = resolveClientIp(cf, RENDER, {
      'x-forwarded-for': `1.2.3.4, 5.6.7.8, ${CLIENT}`,
      'cf-connecting-ip': '1.2.3.4',
    });
    expect(ip).toBe(CLIENT);
  });

  it('with no forwarding header uses the socket address', () => {
    expect(resolveClientIp(cf, '203.0.113.9', {})).toBe('203.0.113.9');
  });

  it('does not trust headers from an arbitrary public peer', () => {
    expect(resolveClientIp(cf, '203.0.113.9', { 'x-forwarded-for': '1.2.3.4' })).toBe('203.0.113.9');
  });

  it('handles IPv6 clients', () => {
    expect(resolveClientIp(cf, RENDER, { 'x-forwarded-for': `2401:4900:1::7, ${EDGE}` })).toBe('2401:4900:1::7');
  });
});

describe('hop-count and none modes', () => {
  it('hops=1 takes the last forwarded entry; spoofed prefix is ignored', () => {
    expect(resolveClientIp(1, RENDER, { 'x-forwarded-for': `6.6.6.6, ${CLIENT}` })).toBe(CLIENT);
  });
  it('none ignores headers', () => {
    expect(resolveClientIp(false, '127.0.0.1', { 'x-forwarded-for': CLIENT })).toBe('127.0.0.1');
  });
});
