/**
 * Firebase's web configuration identifies a public web application. It is
 * deliberately separate from the SDK code so ordinary app startup does not
 * pull Firebase Auth/Messaging into the initial bundle.
 */
export const firebaseWebConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
};

export const firebaseCoreConfigured = [
  firebaseWebConfig.apiKey,
  firebaseWebConfig.authDomain,
  firebaseWebConfig.projectId,
  firebaseWebConfig.appId,
].every(Boolean);

export const firebasePhoneAuthEnabled = import.meta.env.VITE_STUDENT_AUTH_PROVIDER === 'firebase'
  && firebaseCoreConfigured;
export const firebaseFcmVapidKey = import.meta.env.VITE_FIREBASE_FCM_VAPID_KEY as string | undefined;
export const firebaseMessagingEnabled = firebaseCoreConfigured
  && Boolean(firebaseWebConfig.messagingSenderId)
  && Boolean(firebaseFcmVapidKey);

/** Only public Firebase application identifiers enter the service-worker URL. */
export function firebaseMessagingWorkerQuery(): string {
  if (!firebaseMessagingEnabled) return '';
  const values = new URLSearchParams({
    apiKey: firebaseWebConfig.apiKey!,
    authDomain: firebaseWebConfig.authDomain!,
    projectId: firebaseWebConfig.projectId!,
    appId: firebaseWebConfig.appId!,
    messagingSenderId: firebaseWebConfig.messagingSenderId!,
  });
  return `?${values.toString()}`;
}
