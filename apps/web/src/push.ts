import { api } from './api.js';

export function registerServiceWorker(): void {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function pushPermission(): NotificationPermission | 'unsupported' {
  return pushSupported() ? Notification.permission : 'unsupported';
}

function base64ToUint8(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Ask permission + subscribe this device. Must be called from a user gesture.
 * Returns true when notifications will arrive even with the app closed.
 */
export async function enablePush(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const { enabled, key } = await api<{ enabled: boolean; key: string | null }>(
      '/api/push/vapid-public-key',
    );
    if (!enabled || !key) return false;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;

    const registration = await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64ToUint8(key),
      }));

    await api('/api/push/subscribe', {
      method: 'POST',
      role: 'student',
      body: subscription.toJSON(),
    });
    return true;
  } catch {
    return false;
  }
}
