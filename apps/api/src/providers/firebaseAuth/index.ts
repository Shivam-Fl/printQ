import { env } from '../../config/env.js';

type FirebaseAccountLookup = {
  users?: Array<{
    localId?: string;
    phoneNumber?: string;
  }>;
};

export type FirebasePhoneIdentity = { uid: string; phone: string };

/**
 * Ask Google's Identity Toolkit to validate the Firebase ID token and return
 * its verified phone number. The web API key identifies the Firebase project;
 * no service-account private key is needed on the PrintQ server.
 */
export async function verifyFirebasePhoneIdToken(idToken: string): Promise<FirebasePhoneIdentity | null> {
  const key = env.FIREBASE_AUTH_API_KEY;
  if (!key) throw new Error('Firebase phone authentication is not configured');

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  // Invalid, expired, revoked, or wrong-project tokens are ordinary auth
  // failures. Do not leak Google's detailed response to the client.
  if (response.status === 400 || response.status === 401 || response.status === 403) return null;
  if (!response.ok) {
    throw new Error(`Firebase account lookup failed (${response.status})`);
  }

  const payload = (await response.json()) as FirebaseAccountLookup;
  const user = payload.users?.[0];
  const phone = user?.phoneNumber;
  const uid = user?.localId;
  return typeof phone === 'string' && /^\+91[6-9]\d{9}$/.test(phone)
    && typeof uid === 'string' && uid.length > 0
    ? { uid, phone }
    : null;
}
