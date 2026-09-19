import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendEachForMulticast: vi.fn(),
  getMessaging: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../config/env.js', () => ({
  env: {
    FIREBASE_FCM_ENABLED: true,
    PUBLIC_WEB_URL: 'https://development.printqs.example',
  },
}));
vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    fcmSubscription: { findMany: mocks.findMany, deleteMany: mocks.deleteMany },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../lib/logger.js', () => ({ logger: { info: mocks.info } }));
vi.mock('../firebaseAdmin/index.js', () => ({ getFirebaseAdminApp: vi.fn(() => ({ name: 'printq' })) }));
vi.mock('firebase-admin/messaging', () => ({ getMessaging: mocks.getMessaging }));

const { sendFirebasePush } = await import('./index.js');

describe('Firebase Cloud Messaging delivery', () => {
  it('sends only minimal notification data and removes invalid registrations without logging a token', async () => {
    mocks.findMany.mockResolvedValue([
      { id: 'sub-1', token: 'valid-token' },
      { id: 'sub-2', token: 'expired-token' },
    ]);
    mocks.getMessaging.mockReturnValue({
      sendEachForMulticast: mocks.sendEachForMulticast.mockResolvedValue({
        successCount: 1,
        responses: [
          { success: true },
          { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        ],
      }),
    });

    await expect(sendFirebasePush('student-1', {
      title: 'Your print is ready',
      body: 'Collect it at the counter.',
      url: '/jobs/job-1',
      eventKey: 'job-1:ready',
    })).resolves.toBe(1);

    expect(mocks.sendEachForMulticast).toHaveBeenCalledWith(expect.objectContaining({
      notification: { title: 'Your print is ready', body: 'Collect it at the counter.' },
      data: { url: '/jobs/job-1', eventKey: 'job-1:ready' },
      webpush: expect.objectContaining({ fcmOptions: { link: 'https://development.printqs.example/jobs/job-1' } }),
    }));
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { token: { in: ['expired-token'] } } });
    expect(mocks.info).toHaveBeenCalledWith({ studentId: 'student-1', delivered: 1 }, 'fcm_notification_delivered');
  });
});
