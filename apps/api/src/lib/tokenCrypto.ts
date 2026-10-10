import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * AES-256-GCM envelope for recurring-mandate tokens at rest.
 * Format: `v1.<iv b64url>.<tag b64url>.<ciphertext b64url>`. The key comes
 * only from COLLECTION_TOKEN_ENC_KEY (validated in env.ts). The row's identity
 * is bound in as additional authenticated data so a ciphertext copied onto
 * another mandate fails to decrypt.
 */
const PREFIX = 'v1';

function key(): Buffer {
  const raw = env.COLLECTION_TOKEN_ENC_KEY;
  const k = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
  if (k.length !== 32) throw new Error('COLLECTION_TOKEN_ENC_KEY is not configured');
  return k;
}

export function encryptToken(plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/** Throws a generic error on tamper, wrong key, wrong AAD or malformed input. */
export function decryptToken(envelope: string, aad: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error('Invalid encrypted token');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1]!, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Invalid encrypted token');
  }
}

/**
 * Backward compatible read: rows written before encryption hold a bare
 * `token_...` id; anything with the envelope prefix is decrypted.
 */
export function readStoredToken(stored: string, aad: string): string {
  return stored.startsWith(`${PREFIX}.`) ? decryptToken(stored, aad) : stored;
}
