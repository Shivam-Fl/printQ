import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'x'.repeat(64);
process.env.OTP_PEPPER ??= 'y'.repeat(32);
process.env.FIREBASE_AUTH_API_KEY = 'test-public-api-key';

let verifyFirebasePhoneIdToken: typeof import('./index.js').verifyFirebasePhoneIdToken;

beforeAll(async () => {
  ({ verifyFirebasePhoneIdToken } = await import('./index.js'));
});

afterEach(() => vi.unstubAllGlobals());

describe('Firebase phone token verification', () => {
  it('returns a verified Indian phone number', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ users: [{ localId: 'firebase-user', phoneNumber: '+919876543210' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(verifyFirebasePhoneIdToken('verified-token')).resolves.toBe('+919876543210');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ idToken: 'verified-token' }));
  });

  it('rejects expired or wrong-project tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 400 })));
    await expect(verifyFirebasePhoneIdToken('expired-token')).resolves.toBeNull();
  });

  it('rejects identities without a valid Indian phone number', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ users: [{ localId: 'email-only' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(verifyFirebasePhoneIdToken('email-token')).resolves.toBeNull();
  });
});
