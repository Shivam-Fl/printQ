import webpush from 'web-push';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

export const pushEnabled = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

if (pushEnabled) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
}

export interface PushMessage {
  title: string;
  body: string;
  /** in-app path to open on tap, e.g. /jobs/<id> */
  url?: string;
  /** Stable server-side event key for at-least-once delivery de-duplication. */
  eventKey?: string;
}

/**
 * Send a Web Push notification to every device the student installed the PWA
 * on. Dead subscriptions (410/404) are pruned. Never throws — a push failure
 * must not break a queue transition.
 */
export async function sendPush(studentId: string, message: PushMessage): Promise<void> {
  if (!pushEnabled) return;
  const subs = await prisma.pushSubscription.findMany({ where: { studentId } });
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(message),
          { TTL: 600 },
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => undefined);
        } else {
          logger.warn({ err, studentId }, 'push_send_failed');
        }
      }
    }),
  );
}
