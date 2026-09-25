import { getMessaging } from 'firebase-admin/messaging';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { getFirebaseAdminApp } from '../firebaseAdmin/index.js';
import type { PushMessage } from '../push/index.js';

const FCM_BATCH_SIZE = 500;
const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

export const fcmEnabled = env.FIREBASE_FCM_ENABLED;

function notificationUrl(path: string | undefined): string {
  return new URL(path ?? '/', env.PUBLIC_WEB_URL).toString();
}

/**
 * Deliver a privacy-minimal FCM notification to the student's registered web
 * devices. Firebase is only a delivery channel: the client always retrieves
 * authoritative queue, order and financial state from the API after opening.
 * Invalid device registrations are pruned without ever logging their tokens.
 */
export async function sendFirebasePush(studentId: string, message: PushMessage): Promise<number> {
  if (!fcmEnabled) return 0;

  const subscriptions = await prisma.fcmSubscription.findMany({
    where: { studentId },
    select: { id: true, token: true },
  });
  if (subscriptions.length === 0) return 0;

  const messaging = getMessaging(getFirebaseAdminApp());
  const url = notificationUrl(message.url);
  let sent = 0;

  for (let start = 0; start < subscriptions.length; start += FCM_BATCH_SIZE) {
    const batch = subscriptions.slice(start, start + FCM_BATCH_SIZE);
    const response = await messaging.sendEachForMulticast({
      tokens: batch.map((subscription) => subscription.token),
      notification: { title: message.title, body: message.body },
      data: {
        url: message.url ?? '/',
        // A stable server event marker lets the foreground client replace,
        // rather than stack, duplicate at-least-once deliveries.
        eventKey: message.eventKey ?? message.url ?? 'printq-notification',
      },
      webpush: {
        fcmOptions: { link: url },
        notification: {
          tag: message.eventKey ?? message.url ?? 'printq-notification',
          requireInteraction: false,
        },
      },
    });
    sent += response.successCount;

    const invalidTokens = response.responses.flatMap((result, index) => {
      const code = result.error?.code;
      return !result.success && code && INVALID_TOKEN_CODES.has(code) ? [batch[index]!.token] : [];
    });
    if (invalidTokens.length > 0) {
      await prisma.fcmSubscription.deleteMany({ where: { token: { in: invalidTokens } } });
    }
  }

  logger.info({ studentId, delivered: sent }, 'fcm_notification_delivered');
  return sent;
}
