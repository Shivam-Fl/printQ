import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
} from 'node:crypto';
import argon2 from 'argon2';
import { env } from '../config/env.js';

/** Cryptographically random 6-digit OTP (never Math.random). */
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * OTPs are stored hashed with a server-side pepper: a DB leak alone can't
 * reveal them, and 6-digit codes are too small a space to leave unpeppered.
 */
export function hashOtp(otp: string): Promise<string> {
  return argon2.hash(otp + env.OTP_PEPPER, { type: argon2.argon2id });
}

export function verifyOtpHash(hash: string, otp: string): Promise<boolean> {
  return argon2.verify(hash, otp + env.OTP_PEPPER).catch(() => false);
}

const releaseCodeKey = createHash('sha256')
  .update(`printq-release-code:${env.OTP_PEPPER}`)
  .digest();

/** Deterministic, peppered lookup key for a shop's six-digit counter code. */
export function digestReleaseCode(shopId: string, code: string): string {
  return createHmac('sha256', releaseCodeKey).update(`${shopId}:${code}`).digest('hex');
}

/** AES-GCM protects the recoverable code at rest; shopId is authenticated AAD. */
export function encryptReleaseCode(shopId: string, code: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', releaseCodeKey, iv);
  cipher.setAAD(Buffer.from(shopId));
  const ciphertext = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptReleaseCode(shopId: string, value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const [version, iv, tag, ciphertext] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !ciphertext) return null;
    const decipher = createDecipheriv('aes-256-gcm', releaseCodeKey, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(shopId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/** Opaque 48-hex-char agent token; only its sha256 is persisted. */
export function generateAgentToken(): { token: string; tokenHash: string } {
  const token = randomBytes(24).toString('hex');
  return { token, tokenHash: hashAgentToken(token) };
}

export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
