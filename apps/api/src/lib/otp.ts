import { randomInt, createHash, randomBytes } from 'node:crypto';
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

/** Opaque 48-hex-char agent token; only its sha256 is persisted. */
export function generateAgentToken(): { token: string; tokenHash: string } {
  const token = randomBytes(24).toString('hex');
  return { token, tokenHash: hashAgentToken(token) };
}

export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
