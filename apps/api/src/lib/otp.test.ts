import { beforeAll, describe, expect, it } from 'vitest';

// env must exist before the config module loads (fail-fast validation)
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'x'.repeat(64);
process.env.OTP_PEPPER ??= 'y'.repeat(32);

let otpLib: typeof import('./otp.js');

beforeAll(async () => {
  otpLib = await import('./otp.js');
});

describe('release/login OTPs', () => {
  it('generates 6-digit numeric codes', () => {
    for (let i = 0; i < 50; i++) {
      expect(otpLib.generateOtp()).toMatch(/^\d{6}$/);
    }
  });

  it('verifies a correct OTP and rejects a wrong one', async () => {
    const otp = otpLib.generateOtp();
    const hash = await otpLib.hashOtp(otp);
    expect(hash).not.toContain(otp); // never stored in the clear
    expect(await otpLib.verifyOtpHash(hash, otp)).toBe(true);
    expect(await otpLib.verifyOtpHash(hash, '000000')).toBe(false);
  });

  it('verifyOtpHash never throws on garbage hashes', async () => {
    expect(await otpLib.verifyOtpHash('not-a-hash', '123456')).toBe(false);
  });

  it('encrypts stable counter codes and scopes their lookup digest to one shop', () => {
    const code = '482910';
    const encrypted = otpLib.encryptReleaseCode('shop-a', code);
    expect(encrypted).not.toContain(code);
    expect(otpLib.decryptReleaseCode('shop-a', encrypted)).toBe(code);
    expect(otpLib.decryptReleaseCode('shop-b', encrypted)).toBeNull();
    expect(otpLib.digestReleaseCode('shop-a', code)).toBe(otpLib.digestReleaseCode('shop-a', code));
    expect(otpLib.digestReleaseCode('shop-b', code)).not.toBe(otpLib.digestReleaseCode('shop-a', code));
  });
});

describe('agent tokens', () => {
  it('returns a long token and stores only its sha256', () => {
    const { token, tokenHash } = otpLib.generateAgentToken();
    expect(token).toHaveLength(48);
    expect(tokenHash).toHaveLength(64);
    expect(tokenHash).toBe(otpLib.hashAgentToken(token));
    expect(tokenHash).not.toContain(token.slice(0, 8));
  });
});
