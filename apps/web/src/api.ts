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

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
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

/**
 * The API answers a failed schema check with `{ error: 'Validation failed',
 * details: [{ path, message }] }`. Show the first detail, named after its field
 * ("Email is invalid"), rather than the useless generic headline.
 */
function validationMessage(data: { error?: string; details?: { path?: string; message?: string }[] }): string | null {
  if (data.error !== 'Validation failed') return null;
  const first = data.details?.[0];
  if (!first?.message) return null;
  const field = (first.path ?? '').split('.').pop() ?? '';
  const label = field.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  if (!label || first.message.toLowerCase().includes(label)) return first.message;
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${first.message}`;
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
  options: { method?: string; body?: unknown; role?: Role; formData?: FormData; signal?: AbortSignal },
  allowStudentRenewal: boolean,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.role) {
    const token = getToken(options.role);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  Object.assign(headers, await appCheckHeaders());
  let body: BodyInit | undefined;
  if (options.formData) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
    signal: options.signal,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; details?: { path?: string; message?: string }[] };
  if (!res.ok) {
    data.error = validationMessage(data) ?? data.error;
    if (res.status === 401 && options.role === 'student' && allowStudentRenewal) {
      const token = await renewStudentSession();
      if (token) return requestJson<T>(path, options, false);
    }
    if (res.status === 401 && options.role) clearToken(options.role);
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data);
  }
  return data as T;
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; role?: Role; formData?: FormData; signal?: AbortSignal } = {},
): Promise<T> {
  return requestJson<T>(path, options, true);
}

export const rupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

/** Fetch an authenticated binary response (e.g. a receipt PDF) and save it. */
export async function downloadFile(path: string, role: Role, filename: string): Promise<void> {
  let token = getToken(role);
  const appCheck = await appCheckHeaders();
  let res = await fetch(`${API_URL}${path}`, {
    headers: { ...appCheck, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 401 && role === 'student') {
    token = await renewStudentSession();
    if (token) {
      res = await fetch(`${API_URL}${path}`, {
        headers: { ...appCheck, Authorization: `Bearer ${token}` },
      });
    }
  }
  if (res.status === 401) clearToken(role);
  if (!res.ok) throw new ApiError(res.status, `Download failed (${res.status})`);
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
