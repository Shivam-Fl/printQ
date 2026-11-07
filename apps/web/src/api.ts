/**
 * Same-origin by default: dev uses the Vite proxy, production serves the web
 * app from the API. Set VITE_API_URL only for a split-domain deploy.
 */
import { safeStorage } from './lib/safeStorage.js';

/**
 * Build-time environment variables can pick up a trailing newline when they
 * are injected from a dashboard or dotenv file. Keep same-origin mode as an
 * empty string, while making split-domain URLs safe for every consumer.
 */
export function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\/+$/, '');
}

export const API_URL = normalizeBaseUrl(import.meta.env.VITE_API_URL);

type Role = 'student' | 'shop' | 'admin';

const tokenKey = (role: Role) => `printq:${role}:token`;
const firebaseStudentAuthEnabled = import.meta.env.VITE_STUDENT_AUTH_PROVIDER === 'firebase';
const firebaseAppCheckEnabled = import.meta.env.VITE_FIREBASE_APP_CHECK_MODE !== 'disabled'
  && Boolean(import.meta.env.VITE_FIREBASE_APP_CHECK_SITE_KEY);

let studentRenewal: Promise<string | null> | null = null;

async function appCheckHeaders(): Promise<Record<string, string>> {
  if (!firebaseAppCheckEnabled) return {};
  try {
    const { getFirebaseAppCheckToken } = await import('./firebasePhoneAuth.js');
    const token = await getFirebaseAppCheckToken();
    return token ? { 'X-Firebase-AppCheck': token } : {};
  } catch {
    // Monitor mode records the absence server-side. In enforce mode, surface
    // the API's generic app-attestation error rather than leaking SDK detail.
    return {};
  }
}

export function getToken(role: Role): string | null {
  return safeStorage.get(tokenKey(role));
}
export function setToken(role: Role, token: string): void {
  safeStorage.set(tokenKey(role), token);
}
export function clearToken(role: Role): void {
  safeStorage.remove(tokenKey(role));
  if (role === 'shop') safeStorage.remove('printq:shop:role');
}

/** 'owner' | 'staff' for the logged-in shop user — gates owner-only UI (e.g. Staff management). */
export function setShopRole(role: 'owner' | 'staff'): void {
  safeStorage.set('printq:shop:role', role);
}
export function getShopRole(): 'owner' | 'staff' | null {
  return safeStorage.get('printq:shop:role') as 'owner' | 'staff' | null;
}

export const STUDENT_SESSION_EXPIRED_EVENT = 'printq:student-session-expired';
export const STUDENT_SESSION_EXPIRED_MESSAGE = 'Please sign in again.';

/**
 * Central 401 handling for every student route: after one silent renewal
 * attempt has failed, tell the app shell (SessionGuard) to go to /login.
 */
function expireStudentSession(): void {
  try {
    window.dispatchEvent(new Event(STUDENT_SESSION_EXPIRED_EVENT));
  } catch {
    /* non-browser environment */
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
    /** From Retry-After on a 429, so countdowns can show the real wait (a daily cap is an hour). */
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

/**
 * Exchange Firebase's persisted trusted-device session for a fresh PrintQ
 * access token. Firebase refreshes its one-hour ID token without an SMS; a new
 * OTP is needed only after explicit logout, cleared browser data or revocation.
 *
 * A shared promise prevents a page with several concurrent API calls from
 * creating a refresh storm when an old PrintQ token expires.
 */
export async function renewStudentSession(): Promise<string | null> {
  if (!firebaseStudentAuthEnabled) return null;
  if (studentRenewal) return studentRenewal;

  studentRenewal = (async () => {
    const { resumeFirebasePhoneSession } = await import('./firebasePhoneAuth.js');
    const idToken = await resumeFirebasePhoneSession(true);
    if (!idToken) return null;

    const response = await fetch(`${API_URL}/api/auth/student/firebase-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (!response.ok) return null;

    const data = (await response.json().catch(() => ({}))) as { token?: unknown };
    if (typeof data.token !== 'string' || !data.token) return null;
    setToken('student', data.token);
    window.dispatchEvent(new Event('printq:student-session-renewed'));
    return data.token;
  })()
    .catch(() => null)
    .finally(() => {
      studentRenewal = null;
    });

  return studentRenewal;
}

type ErrorBody = { error?: string; details?: { path?: string; message?: string }[] };

export const NETWORK_ERROR_MESSAGE = 'Can’t reach PrintQs. Check your internet and try again.';
export const BUSY_ERROR_MESSAGE = 'PrintQs is waking up or busy — try again in a few seconds.';

const FIELD_LABELS: Record<string, string> = { otp: 'code', pin: 'PIN' };

function fieldLabel(path: string | undefined): string {
  const field = (path ?? '').split('.').pop() ?? '';
  const label = FIELD_LABELS[field] ?? field.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  return label ? `${label.charAt(0).toUpperCase()}${label.slice(1)}` : '';
}

/** Turn zod's developer wording ("Too small: expected string to have >=8 characters") into plain English. */
function plainIssue(label: string, message: string): string {
  const name = label || 'This field';
  let m = /^Too small: expected string to have >=(\d+) characters?/.exec(message);
  if (m) return `${name} must be at least ${m[1]} characters`;
  m = /^Too big: expected string to have <=(\d+) characters?/.exec(message);
  if (m) return `${name} must be at most ${m[1]} characters`;
  m = /^Too small: expected number to be >=?(\S+)/.exec(message);
  if (m) return `${name} must be at least ${m[1]}`;
  m = /^Too big: expected number to be <=?(\S+)/.exec(message);
  if (m) return `${name} must be at most ${m[1]}`;
  if (/^Invalid email/i.test(message)) return 'Enter a valid email address';
  if (/received undefined$/.test(message)) return `${name} is required`;
  if (/^Invalid (input|string|option|format)/i.test(message)) return `${name} is not valid`;
  if (!label || message.toLowerCase().includes(label.toLowerCase())) return message;
  return `${label}: ${message}`;
}

/**
 * The API answers a failed schema check with `{ error: 'Validation failed',
 * details: [{ path, message }] }`. Show the first detail, named after its field
 * ("Email is invalid"), rather than the useless generic headline.
 */
function validationMessage(data: ErrorBody): string | null {
  if (data.error !== 'Validation failed') return null;
  const first = data.details?.[0];
  if (!first?.message) return null;
  return plainIssue(fieldLabel(first.path), first.message);
}

/**
 * Every field the API rejected, keyed by field name ("email", "password"), in
 * plain English. Forms use it to show each message next to its own input.
 */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const data = (err.body ?? {}) as ErrorBody;
  if (data.error !== 'Validation failed' || !Array.isArray(data.details)) return {};
  const out: Record<string, string> = {};
  for (const detail of data.details) {
    const field = (detail.path ?? '').split('.').pop() ?? '';
    if (!field || !detail.message || out[field]) continue;
    out[field] = plainIssue(fieldLabel(field), detail.message);
  }
  return out;
}

/** Seconds from a Retry-After header (delta-seconds or an HTTP date); null when absent or unreadable. */
export function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const value = header.trim();
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function rateLimitMessage(retryAfter: string | null): string {
  const seconds = retryAfterSeconds(retryAfter);
  if (!seconds) return 'Too many attempts. Please wait a minute and try again.';
  if (seconds < 90) return `Too many attempts. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`;
  return `Too many attempts. Try again in about ${Math.ceil(seconds / 60)} minutes.`;
}

/**
 * The words a person sees for a failed request. Never a raw "Request failed
 * (502)": gateways and cold starts read as "busy", rate limits say how long to
 * wait, and schema failures name the field in plain English.
 */
export function errorMessageFor(status: number, data: ErrorBody, retryAfter: string | null = null): string {
  if (status === 429) {
    // Keep a specific server reason ("…for this number today"); replace the generic limiter text.
    if (data.error && !/^too many requests/i.test(data.error)) return data.error;
    return rateLimitMessage(retryAfter);
  }
  if (status === 502 || status === 503 || status === 504) return BUSY_ERROR_MESSAGE;
  const validation = validationMessage(data);
  if (validation) return validation;
  if (typeof data.error === 'string' && data.error) return data.error;
  return 'Something went wrong. Please try again.';
}

/** fetch() that turns "Failed to fetch" (offline, DNS, CORS, server down) into a friendly ApiError(0). */
async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted || (err as { name?: string } | null)?.name === 'AbortError') throw err;
    throw new ApiError(0, NETWORK_ERROR_MESSAGE);
  }
}

/** Sign out of the shop dashboard: revoke the session server-side (best effort), then forget the token. */
export async function signOutShop(): Promise<void> {
  try {
    await api('/api/auth/shop/logout', { method: 'POST', role: 'shop' });
  } catch {
    /* offline or already expired — local sign-out still proceeds */
  }
  clearToken('shop');
}

async function requestJson<T>(
  path: string,
  options: { method?: string; body?: unknown; role?: Role; formData?: FormData; signal?: AbortSignal; idempotencyKey?: string },
  allowStudentRenewal: boolean,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.role) {
    const token = getToken(options.role);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  Object.assign(headers, await appCheckHeaders());
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  let body: BodyInit | undefined;
  if (options.formData) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const res = await send(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
    signal: options.signal,
  });
  const data = (await res.json().catch(() => ({}))) as ErrorBody;
  if (!res.ok) {
    if (res.status === 401 && options.role === 'student' && allowStudentRenewal) {
      const token = await renewStudentSession();
      if (token) return requestJson<T>(path, options, false);
    }
    if (res.status === 401 && options.role) clearToken(options.role);
    if (res.status === 401 && options.role === 'student') {
      // Renewal already failed (or was not possible): the student must sign in again.
      expireStudentSession();
      throw new ApiError(401, STUDENT_SESSION_EXPIRED_MESSAGE, data);
    }
    const retryAfter = res.headers.get('Retry-After');
    throw new ApiError(
      res.status,
      errorMessageFor(res.status, data, retryAfter),
      data,
      res.status === 429 ? retryAfterSeconds(retryAfter) : null,
    );
  }
  return data as T;
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; role?: Role; formData?: FormData; signal?: AbortSignal; idempotencyKey?: string } = {},
): Promise<T> {
  return requestJson<T>(path, options, true);
}

export const rupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

/** Authenticated binary fetch (header auth, one silent student renewal). Used by the PDF preview. */
export async function fetchBytes(path: string, role: Role, signal?: AbortSignal): Promise<ArrayBuffer> {
  const appCheck = await appCheckHeaders();
  const request = (token: string | null) =>
    send(`${API_URL}${path}`, {
      headers: { ...appCheck, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal,
      referrerPolicy: 'no-referrer',
    });
  let res = await request(getToken(role));
  if (res.status === 401 && role === 'student') {
    const token = await renewStudentSession();
    if (token) res = await request(token);
  }
  if (res.status === 401) {
    clearToken(role);
    if (role === 'student') expireStudentSession();
  }
  if (!res.ok) throw new ApiError(res.status, errorMessageFor(res.status, {}, res.headers.get('Retry-After')));
  return res.arrayBuffer();
}

/** Fetch an authenticated binary response (e.g. a receipt PDF) and save it. */
export async function downloadFile(path: string, role: Role, filename: string): Promise<void> {
  let token = getToken(role);
  const appCheck = await appCheckHeaders();
  let res = await send(`${API_URL}${path}`, {
    headers: { ...appCheck, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 401 && role === 'student') {
    token = await renewStudentSession();
    if (token) {
      res = await send(`${API_URL}${path}`, {
        headers: { ...appCheck, Authorization: `Bearer ${token}` },
      });
    }
  }
  if (res.status === 401) {
    clearToken(role);
    if (role === 'student') expireStudentSession();
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as ErrorBody;
    throw new ApiError(res.status, errorMessageFor(res.status, data, res.headers.get('Retry-After')));
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Remember the last shop the student ordered from, so "New print" has a target. */
export function rememberShop(slug: string): void {
  safeStorage.set('printq:lastShop', slug);
}
export function lastShopSlug(): string | null {
  return safeStorage.get('printq:lastShop');
}

/** Relative time like "2h ago", "just now". */
export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}
