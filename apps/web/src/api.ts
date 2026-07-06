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
