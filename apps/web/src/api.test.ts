import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.VITE_STUDENT_AUTH_PROVIDER = 'firebase';

const storage = new Map<string, string>();
const resumeFirebasePhoneSession = vi.fn<() => Promise<string | null>>();

const getFirebaseAppCheckToken = vi.fn<() => Promise<string | null>>();
vi.mock('./firebasePhoneAuth.js', () => ({ resumeFirebasePhoneSession, getFirebaseAppCheckToken }));

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { dispatchEvent: vi.fn() },
});
Object.defineProperty(globalThis, 'Event', {
  configurable: true,
  value: class TestEvent {
    constructor(public readonly type: string) {}
  },
});

let apiModule: typeof import('./api.js');

beforeAll(async () => {
  apiModule = await import('./api.js');
});

beforeEach(() => {
  storage.clear();
  resumeFirebasePhoneSession.mockReset();
  getFirebaseAppCheckToken.mockReset();
  getFirebaseAppCheckToken.mockResolvedValue(null);
  vi.restoreAllMocks();
});

describe('student session renewal', () => {
  it('silently exchanges a persisted Firebase session and retries one failed request', async () => {
    storage.set('printq:student:token', 'expired-printq-token');
    resumeFirebasePhoneSession.mockResolvedValue('fresh-firebase-id-token');

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'fresh-printq-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ student: { id: 'student-1' } }), { status: 200 }));

    const result = await apiModule.api<{ student: { id: string } }>('/api/auth/student/me', {
      role: 'student',
    });

    expect(result.student.id).toBe('student-1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/auth/student/firebase-login');
    expect(storage.get('printq:student:token')).toBe('fresh-printq-token');
  });

  it('coalesces concurrent refreshes so only one Firebase exchange is made', async () => {
    let release!: (value: string) => void;
    resumeFirebasePhoneSession.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ token: 'one-new-token' }), { status: 200 }));

    const first = apiModule.renewStudentSession();
    const second = apiModule.renewStudentSession();
    release('one-firebase-token');

    await expect(Promise.all([first, second])).resolves.toEqual(['one-new-token', 'one-new-token']);
    expect(resumeFirebasePhoneSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears the stale PrintQ token only when trusted-device renewal is unavailable', async () => {
    storage.set('printq:student:token', 'stale-token');
    resumeFirebasePhoneSession.mockResolvedValue(null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    );

    await expect(apiModule.api('/api/jobs', { role: 'student' })).rejects.toMatchObject({ status: 401 });
    expect(storage.has('printq:student:token')).toBe(false);
  });
});

describe('validation errors (OWN-12)', () => {
  it('surfaces the first field-specific message instead of "Validation failed"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'Validation failed',
      details: [{ path: 'email', message: 'Email is invalid' }, { path: 'password', message: 'Password must be at least 8 characters' }],
    }), { status: 400 }));
    await expect(apiModule.api('/api/auth/shop/register', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 400,
      message: 'Email is invalid',
    });
  });

  it('keeps the plain error text when there are no details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }));
    await expect(apiModule.api('/api/x')).rejects.toMatchObject({ message: 'Not found' });
  });
});

describe('shop sign-out (OWN-4)', () => {
  it('revokes the session on the server, then clears the local token', async () => {
    storage.set('printq:shop:token', 'shop-jwt');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await apiModule.signOutShop();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/auth/shop/logout');
    expect((init as RequestInit).method).toBe('POST');
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer shop-jwt');
    expect(storage.has('printq:shop:token')).toBe(false);
  });

  it('still signs out locally when the network call fails', async () => {
    storage.set('printq:shop:token', 'shop-jwt');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await apiModule.signOutShop();
    expect(storage.has('printq:shop:token')).toBe(false);
  });
});

describe('API base URL configuration', () => {
  it('trims deployment whitespace and trailing slashes', () => {
    expect(apiModule.normalizeBaseUrl(' https://api.printqs.com/\r\n')).toBe('https://api.printqs.com');
  });

  it('preserves same-origin mode for missing or whitespace-only configuration', () => {
    expect(apiModule.normalizeBaseUrl(undefined)).toBe('');
    expect(apiModule.normalizeBaseUrl(' \r\n\t ')).toBe('');
  });
});
