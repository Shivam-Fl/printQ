import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getToken as getAppCheckToken,
  initializeAppCheck,
  ReCaptchaV3Provider,
  type AppCheck,
} from 'firebase/app-check';
import {
  browserLocalPersistence,
  getAuth,
  RecaptchaVerifier,
  setPersistence,
  signInWithPhoneNumber,
  signOut,
  type ConfirmationResult,
} from 'firebase/auth';
import type { Messaging } from 'firebase/messaging';
import {
  firebaseCoreConfigured,
  firebaseFcmVapidKey,
  firebaseMessagingEnabled,
  firebasePhoneAuthEnabled,
  firebaseWebConfig,
} from './firebaseConfig.js';

export { firebasePhoneAuthEnabled };

const appCheckMode = import.meta.env.VITE_FIREBASE_APP_CHECK_MODE as string | undefined;
const appCheckSiteKey = import.meta.env.VITE_FIREBASE_APP_CHECK_SITE_KEY as string | undefined;

let verifier: RecaptchaVerifier | null = null;
let confirmation: ConfirmationResult | null = null;
let appCheck: AppCheck | null = null;
let firebaseMessaging: Messaging | null = null;
let foregroundMessageBound = false;
const OTP_SEND_COOLDOWN_MS = 60_000;
const OTP_SEND_KEY = 'printq:student:otp-sent-at';

export function getFirebaseApp(): FirebaseApp {
  if (!firebaseCoreConfigured) throw new Error('Firebase is not configured');
  return getApps().length ? getApp() : initializeApp(firebaseWebConfig);
}

function auth() {
  if (!firebasePhoneAuthEnabled) throw new Error('Phone verification is not configured');
  const app = getFirebaseApp();
  const instance = getAuth(app);
  instance.useDeviceLanguage();
  return instance;
}

/**
 * Returns an App Check assertion for the custom API without ever placing it
 * in a URL. This is deliberately opt-in: monitor mode is enabled only after
 * the matching Firebase web provider has been configured in that environment.
 */
export async function getFirebaseAppCheckToken(): Promise<string | null> {
  if (appCheckMode === 'disabled' || !appCheckMode || !appCheckSiteKey || !firebaseCoreConfigured) return null;
  const app = getFirebaseApp();
  appCheck ??= initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
  const token = await getAppCheckToken(appCheck, false);
  return token.token;
}

/**
 * Fetch an FCM registration token only after a user-triggered notification
 * permission request. The token is opaque, never logged, and exchanged with
 * the API over the authenticated student session.
 */
export async function getFirebaseMessagingToken(
  serviceWorkerRegistration: ServiceWorkerRegistration,
): Promise<string | null> {
  if (!firebaseMessagingEnabled || !firebaseFcmVapidKey) return null;
  const messagingSdk = await import('firebase/messaging');
  if (!(await messagingSdk.isSupported())) return null;
  firebaseMessaging ??= messagingSdk.getMessaging(getFirebaseApp());

  if (!foregroundMessageBound) {
    messagingSdk.onMessage(firebaseMessaging, (payload) => {
      const data = payload.data ?? {};
      window.dispatchEvent(new CustomEvent('printq:firebase-notification', {
        detail: {
          title: payload.notification?.title ?? 'PrintQ',
          body: payload.notification?.body ?? '',
          url: data.url,
          eventKey: data.eventKey,
        },
      }));
    });
    foregroundMessageBound = true;
  }

  return messagingSdk.getToken(firebaseMessaging, {
    vapidKey: firebaseFcmVapidKey,
    serviceWorkerRegistration,
  });
}

/** Reuse Firebase's trusted-device session so returning students do not need
 * another paid SMS only because the PrintQ JWT reached its 30-day expiry. */
export async function resumeFirebasePhoneSession(forceRefresh = false): Promise<string | null> {
  if (!firebasePhoneAuthEnabled) return null;
  const authInstance = auth();
  await authInstance.authStateReady();
  return authInstance.currentUser?.getIdToken(forceRefresh) ?? null;
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
  const lastSentAt = Number(localStorage.getItem(OTP_SEND_KEY) ?? '0');
  const waitMs = OTP_SEND_COOLDOWN_MS - (Date.now() - lastSentAt);
  if (waitMs > 0) {
    throw new Error(`Please wait ${Math.ceil(waitMs / 1000)} seconds before requesting another code.`);
  }

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
    localStorage.setItem(OTP_SEND_KEY, String(Date.now()));
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
