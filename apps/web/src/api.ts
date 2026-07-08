/**
 * Same-origin by default: dev uses the Vite proxy, production serves the web
 * app from the API. Set VITE_API_URL only for a split-domain deploy.
 */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

type Role = 'student' | 'shop';

const tokenKey = (role: Role) => `printq:${role}:token`;

export function getToken(role: Role): string | null {
  return localStorage.getItem(tokenKey(role));
}
export function setToken(role: Role, token: string): void {
  localStorage.setItem(tokenKey(role), token);
}
export function clearToken(role: Role): void {
  localStorage.removeItem(tokenKey(role));
}

/** 'owner' | 'staff' for the logged-in shop user — gates owner-only UI (e.g. Staff management). */
export function setShopRole(role: 'owner' | 'staff'): void {
  localStorage.setItem('printq:shop:role', role);
}
export function getShopRole(): 'owner' | 'staff' | null {
  return localStorage.getItem('printq:shop:role') as 'owner' | 'staff' | null;
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

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; role?: Role; formData?: FormData } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.role) {
    const token = getToken(options.role);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let body: BodyInit | undefined;
  if (options.formData) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const res = await fetch(`${API_URL}${path}`, { method: options.method ?? 'GET', headers, body });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401 && options.role) clearToken(options.role);
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data);
  }
  return data as T;
}

export const rupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

/** Fetch an authenticated binary response (e.g. a receipt PDF) and save it. */
export async function downloadFile(path: string, role: Role, filename: string): Promise<void> {
  const token = getToken(role);
  const res = await fetch(`${API_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
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
  localStorage.setItem('printq:lastShop', slug);
}
export function lastShopSlug(): string | null {
  return localStorage.getItem('printq:lastShop');
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
