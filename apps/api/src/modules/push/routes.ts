import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, notFound, unauthorized } from '../../lib/errors.js';
import { requireStudent } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { pushEnabled } from '../../providers/push/index.js';

export const pushRouter = Router();

/** Public: the client needs the VAPID public key to subscribe. Not a secret. */
pushRouter.get('/vapid-public-key', (_req, res) => {
  res.json({ enabled: pushEnabled, key: env.VAPID_PUBLIC_KEY ?? null });
});

const subscribeSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(1).max(300),
    auth: z.string().min(1).max(100),
  }),
});

/** Store this device's push subscription for the logged-in student. */
pushRouter.post(
  '/subscribe',
  requireStudent,
  validateBody(subscribeSchema),
  asyncHandler(async (req, res) => {
    const { endpoint, keys } = req.body as z.infer<typeof subscribeSchema>;
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { studentId: req.student!.id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
      // endpoint reused after re-login on a shared device → move it to the new owner
      update: { studentId: req.student!.id, p256dh: keys.p256dh, auth: keys.auth },
    });
    res.json({ ok: true });
  }),
);

const fcmSubscriptionSchema = z.object({
  // FCM registration tokens are opaque and may evolve in length. They are
  // stored only server-side and are never written to logs or API responses.
  token: z.string().min(32).max(4_096),
});

/** Register the current Firebase-authenticated student's FCM web device. */
pushRouter.post(
  '/fcm-subscribe',
  requireStudent,
  validateBody(fcmSubscriptionSchema),
  asyncHandler(async (req, res) => {
    if (!env.FIREBASE_FCM_ENABLED) throw notFound();
    const student = await prisma.student.findUnique({
      where: { id: req.student!.id },
      select: { firebaseUid: true },
    });
    if (!student?.firebaseUid) throw unauthorized('Firebase sign-in is required for notifications');

    const { token } = req.body as z.infer<typeof fcmSubscriptionSchema>;
    await prisma.fcmSubscription.upsert({
      where: { token },
      create: { studentId: req.student!.id, token },
      // A browser can be signed out then used by a different student. Move
      // the opaque device token to the authenticated current owner.
      update: { studentId: req.student!.id },
    });
    res.json({ ok: true });
  }),
);

pushRouter.post(
  '/fcm-unsubscribe',
  requireStudent,
  validateBody(fcmSubscriptionSchema),
  asyncHandler(async (req, res) => {
    const { token } = req.body as z.infer<typeof fcmSubscriptionSchema>;
    await prisma.fcmSubscription.deleteMany({ where: { token, studentId: req.student!.id } });
    res.json({ ok: true });
  }),
);

pushRouter.post(
  '/unsubscribe',
  requireStudent,
  validateBody(z.object({ endpoint: z.string().url().max(1000) })),
  asyncHandler(async (req, res) => {
    const { endpoint } = req.body as { endpoint: string };
    await prisma.pushSubscription.deleteMany({
      where: { endpoint, studentId: req.student!.id },
    });
    res.json({ ok: true });
  }),
);
