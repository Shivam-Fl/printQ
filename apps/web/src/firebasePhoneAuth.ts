import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  RecaptchaVerifier,
  setPersistence,
  signInWithPhoneNumber,
  signOut,
  type ConfirmationResult,
} from 'firebase/auth';

const provider = import.meta.env.VITE_STUDENT_AUTH_PROVIDER as string | undefined;
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

export const firebasePhoneAuthEnabled =
  provider === 'firebase' && Object.values(firebaseConfig).every((value) => Boolean(value));

let verifier: RecaptchaVerifier | null = null;
let confirmation: ConfirmationResult | null = null;

function auth() {
  if (!firebasePhoneAuthEnabled) throw new Error('Phone verification is not configured');
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  const instance = getAuth(app);
  instance.useDeviceLanguage();
  return instance;
}

/** Reuse Firebase's trusted-device session so returning students do not need
 * another paid SMS only because the PrintQ JWT reached its 30-day expiry. */
export async function resumeFirebasePhoneSession(): Promise<string | null> {
  if (!firebasePhoneAuthEnabled) return null;
  const authInstance = auth();
  await authInstance.authStateReady();
  return authInstance.currentUser?.getIdToken() ?? null;
}

export async function signOutFirebasePhoneAuth(): Promise<void> {
  if (!firebasePhoneAuthEnabled) return;
  resetFirebasePhoneAuth();
  await signOut(auth());
}

export function resetFirebasePhoneAuth(): void {
  try {
    verifier?.clear();
  } catch {
    // The widget may already have been removed during navigation.
  }
  verifier = null;
  confirmation = null;
  document.getElementById('printq-recaptcha')?.replaceChildren();
}

export async function requestFirebasePhoneOtp(phoneE164: string): Promise<void> {
  resetFirebasePhoneAuth();
  const authInstance = auth();
  // A trusted-device Firebase session lets us refresh a returning student's
  // PrintQ session without paying for another SMS. Explicit logout clears both.
  await setPersistence(authInstance, browserLocalPersistence);
  verifier = new RecaptchaVerifier(authInstance, 'printq-recaptcha', {
    size: 'invisible',
  });

  try {
    await verifier.render();
    confirmation = await signInWithPhoneNumber(authInstance, phoneE164, verifier);
  } catch (error) {
    resetFirebasePhoneAuth();
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (code.includes('too-many-requests')) throw new Error('Too many attempts. Please wait and try again.');
    if (code.includes('invalid-phone-number')) throw new Error('Enter a valid Indian mobile number.');
    if (code.includes('captcha-check-failed')) throw new Error('Security check failed. Refresh and try again.');
    if (code.includes('operation-not-allowed')) throw new Error('Phone sign-in is temporarily unavailable.');
    throw new Error('Could not send the verification code. Please try again.');
  }
}

export async function verifyFirebasePhoneOtp(code: string): Promise<string> {
  if (!confirmation) throw new Error('Request a new code first.');
  try {
    const credential = await confirmation.confirm(code);
    const idToken = await credential.user.getIdToken(true);
    confirmation = null;
    return idToken;
  } catch (error) {
    const errorCode = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (errorCode.includes('invalid-verification-code')) throw new Error('That code is incorrect.');
    if (errorCode.includes('code-expired')) throw new Error('That code expired. Request a new one.');
    throw new Error('Could not verify the code. Please try again.');
  }
}
