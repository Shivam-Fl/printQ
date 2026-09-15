import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.VITE_STUDENT_AUTH_PROVIDER = 'firebase';

const storage = new Map<string, string>();
const resumeFirebasePhoneSession = vi.fn<() => Promise<string | null>>();

vi.mock('./firebasePhoneAuth.js', () => ({ resumeFirebasePhoneSession }));

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
