import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import type { PushMessage } from '../push/index.js';
import { sendFirebasePush } from './index.js';

const DELIVERY_LEASE_MS = 60_000;

function stableEventKey(message: PushMessage): string {
  if (message.eventKey) return message.eventKey;
  // Existing notification call sites that have not yet supplied a domain event
  // key remain idempotent for identical user-visible notifications.
  return `legacy:${createHash('sha256')
    .update(JSON.stringify([message.title, message.body, message.url ?? '']))
    .digest('hex')}`;
}

/** Store outbound FCM work before trying delivery. The unique event key makes
 * duplicate worker/outbox publication harmless without making Firebase a
 * business-state authority. */
export async function enqueueFirebaseNotification(studentId: string, message: PushMessage): Promise<void> {
  if (!env.FIREBASE_FCM_ENABLED) return;
  await prisma.notificationDelivery.upsert({
    where: { studentId_eventKey: { studentId, eventKey: stableEventKey(message) } },
    create: {
      studentId,
      eventKey: stableEventKey(message),
      title: message.title,
      body: message.body,
      url: message.url ?? null,
    },
    update: {},
  });
}

/**
 * Claim and publish pending FCM delivery work. A bounded lease prevents two
 * workers from normally sending the same event. The FCM notification tag is
 * also the event key, so the client replaces a rare at-least-once retry.
 */
export async function publishPendingFirebaseNotifications(limit = 100): Promise<number> {
  if (!env.FIREBASE_FCM_ENABLED) return 0;
  const now = new Date();
  const pending = await prisma.notificationDelivery.findMany({
    where: {
      deliveredAt: null,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  let delivered = 0;

  for (const delivery of pending) {
    const claimed = await prisma.notificationDelivery.updateMany({
      where: {
        id: delivery.id,
        deliveredAt: null,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: {
        attempts: { increment: 1 },
        leaseExpiresAt: new Date(now.getTime() + DELIVERY_LEASE_MS),
        lastError: null,
      },
    });
    if (claimed.count === 0) continue;

    try {
      await sendFirebasePush(delivery.studentId, {
        title: delivery.title,
        body: delivery.body,
        url: delivery.url ?? undefined,
        eventKey: delivery.eventKey,
      });
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: { deliveredAt: new Date(), leaseExpiresAt: null, lastError: null },
      });
      delivered += 1;
    } catch (error) {
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          leaseExpiresAt: null,
          lastError: error instanceof Error ? error.message.slice(0, 300) : 'FCM delivery failed',
        },
      }).catch((recordError) => logger.error({ recordError, deliveryId: delivery.id }, 'fcm_delivery_record_failed'));
      logger.error({ error, deliveryId: delivery.id }, 'fcm_delivery_failed');
    }
  }
  return delivered;
}
