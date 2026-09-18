import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAppCheck, type VerifyAppCheckTokenResponse } from 'firebase-admin/app-check';
import { env } from '../../config/env.js';

let firebaseAdminApp: App | null = null;

/**
 * Initializes the privileged Firebase client only for a server feature that
 * needs it. Cloud Run supplies Application Default Credentials through the
 * narrowly scoped runtime identity; service-account JSON is intentionally
 * unsupported in PrintQs configuration.
 */
export function getFirebaseAdminApp(): App {
  if (firebaseAdminApp) return firebaseAdminApp;
  if (!env.FIREBASE_PROJECT_ID) throw new Error('Firebase server feature requires FIREBASE_PROJECT_ID');

  const name = `printqs-${env.PRINTQ_ENVIRONMENT}`;
  firebaseAdminApp = getApps().find((app) => app.name === name)
    ?? initializeApp({ credential: applicationDefault(), projectId: env.FIREBASE_PROJECT_ID }, name);
  return firebaseAdminApp;
}

/** Verify a client-supplied App Check token without logging or persisting it. */
export async function verifyFirebaseAppCheckToken(token: string): Promise<VerifyAppCheckTokenResponse> {
  return getAppCheck(getFirebaseAdminApp()).verifyToken(token);
}
