/**
 * One-time "why was I signed out?" notice for the shop login page (PSLS-1).
 *
 * Sign-out and password reset revoke every shop session. The API answers a
 * revoked token with the same plain 401 as an expired one, so the web tells them
 * apart by the token itself: a 12-hour shop token refused before its own expiry
 * was revoked elsewhere. Kept in memory: the trip to /dashboard/login is an
 * in-app navigation, and the notice must show once only.
 */

export const SESSION_ENDED_NOTICE = 'You were signed out because your password was changed or you signed out on another device.';

let pending = false;

/** The `exp` claim (seconds since epoch) of a JWT, or null when it cannot be read. */
export function tokenExpiry(token: string | null | undefined): number | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as { exp?: unknown };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp : null;
  } catch {
    return null;
  }
}

/** A token the server refused while it had not expired yet: the session was revoked, not timed out. */
export function wasRevoked(token: string | null | undefined, nowMs: number = Date.now()): boolean {
  const exp = tokenExpiry(token);
  return exp !== null && exp * 1000 > nowMs;
}

/** Call when a shop session ended with a 401; only a revoked (unexpired) token queues the notice. */
export function noteShopSessionEnded(token: string | null | undefined, nowMs: number = Date.now()): void {
  if (wasRevoked(token, nowMs)) pending = true;
}

/** The notice once, then null. */
export function takeShopSessionNotice(): string | null {
  if (!pending) return null;
  pending = false;
  return SESSION_ENDED_NOTICE;
}

/** A sign-out on this device needs no explanation. */
export function clearShopSessionNotice(): void {
  pending = false;
}
