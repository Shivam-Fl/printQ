/** Pure helpers behind the student phone + OTP steps, kept DOM-free so they are unit-testable. */

/**
 * Turn whatever was typed, pasted or autofilled into the national digits of an
 * Indian mobile. '+91 98100 00003', '919810000003' and '09810000003' all give
 * '9810000003'. The +91 / 0 prefix is removed BEFORE anything is cut off, so a
 * pasted country code can never shift the number into a stranger's.
 *
 * While a prefixed number is still being typed ('91…' up to 12 digits, '0…' up
 * to 11) the extra digits are kept so typing can finish; otherwise the field
 * holds at most 10 digits.
 */
export function normalizeIndianMobile(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  // Strip every leading 0 / 91 country prefix ('091 98…', '+91 0 98…'), then
  // keep up to 12 digits: anything past 10 is a typo the hint must flag, never
  // something to silently cut into a stranger's number.
  let national = digits;
  while (national.length > 10 && (national.startsWith('0') || national.startsWith('91'))) {
    national = national.startsWith('0') ? national.slice(1) : national.slice(2);
  }
  if (national !== digits) return national.slice(0, 12);
  const max = digits.startsWith('91') ? 12 : digits.startsWith('0') ? 11 : 10;
  return digits.slice(0, max);
}

/** 10 digits starting 6-9: the only numbers the server will text a code to. */
export function isValidIndianMobile(national: string): boolean {
  return /^[6-9]\d{9}$/.test(national);
}

/**
 * Why "Send" is still disabled, in plain words. Null when the number is fine or
 * the field is empty. `finished` is true once the student has left the field
 * (or pressed Enter): a half-typed number only gets a hint at that point.
 */
export function phoneHint(national: string, finished: boolean): string | null {
  if (!national || isValidIndianMobile(national)) return null;
  if (national.length > 10) return 'That is more than 10 digits. Check the number.';
  if (/^[1-5]/.test(national)) return 'Indian mobile numbers start with 6, 7, 8 or 9.';
  return finished ? 'Enter your 10-digit mobile number.' : null;
}

/**
 * The 6-digit code from whatever landed in the OTP box: typed digits, a pasted
 * '123 456' / '123-456', or a whole SMS ('Your PrintQ code is 123456.').
 * A standalone 6-digit run wins; otherwise keep the first 6 digits.
 */
export function extractOtp(raw: string): string {
  const run = /(?:^|\D)(\d{6})(?!\d)/.exec(raw);
  if (run?.[1]) return run[1];
  return raw.replace(/\D/g, '').slice(0, 6);
}

/**
 * Seconds to wait after a "slow down" error, or null if the error is not one.
 * A 429 uses Retry-After when the API client exposes it, else the wait named in
 * the message ("Try again in 42 seconds", "about 3 minutes"), else 60s. The
 * Firebase path's own cooldown says "Please wait N seconds…" with no status.
 */
export function waitSecondsFromError(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const { status, retryAfterSeconds, message } = err as {
    status?: unknown;
    retryAfterSeconds?: unknown;
    message?: unknown;
  };
  if (status === 429 && typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0) {
    return Math.ceil(retryAfterSeconds);
  }
  const text = typeof message === 'string' ? message : '';
  const seconds = /(?:wait|in) (\d+) seconds?/i.exec(text);
  if (seconds) return Number(seconds[1]);
  const minutes = /(?:wait|in) (?:about )?(\d+) minutes?/i.exec(text);
  if (status === 429 && minutes) return Number(minutes[1]) * 60;
  return status === 429 ? 60 : null;
}

/** '45s' under a minute, '2 min' above (a daily cap can be an hour). */
export function formatWait(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`;
}
