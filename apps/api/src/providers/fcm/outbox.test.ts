import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  send: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../config/env.js', () => ({ env: { FIREBASE_FCM_ENABLED: true } }));
vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    notificationDelivery: {
      upsert: mocks.upsert,
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
      update: mocks.update,
    },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../lib/logger.js', () => ({ logger: { error: mocks.error } }));
vi.mock('./index.js', () => ({ sendFirebasePush: mocks.send }));

const { enqueueFirebaseNotification, publishPendingFirebaseNotifications } = await import('./outbox.js');

describe('Firebase notification outbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores a stable event key so duplicate publication shares one durable delivery record', async () => {
    mocks.upsert.mockResolvedValue({ id: 'delivery-1' });
    await enqueueFirebaseNotification('student-1', {
      title: 'Queue update', body: 'You are number 2', url: '/jobs/job-1', eventKey: 'job-1:queued:2',
    });

    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { studentId_eventKey: { studentId: 'student-1', eventKey: 'job-1:queued:2' } },
      create: expect.objectContaining({ studentId: 'student-1', eventKey: 'job-1:queued:2' }),
    }));
  });

  it('leases then marks a successful FCM delivery exactly once', async () => {
    mocks.findMany.mockResolvedValue([{
      id: 'delivery-1', studentId: 'student-1', eventKey: 'job-1:ready',
      title: 'Ready', body: 'Collect it', url: '/jobs/job-1',
    }]);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.send.mockResolvedValue(1);
    mocks.update.mockResolvedValue({ id: 'delivery-1' });

    await expect(publishPendingFirebaseNotifications()).resolves.toBe(1);
    expect(mocks.send).toHaveBeenCalledWith('student-1', {
      title: 'Ready', body: 'Collect it', url: '/jobs/job-1', eventKey: 'job-1:ready',
    });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'delivery-1' },
      data: expect.objectContaining({ leaseExpiresAt: null, lastError: null }),
    }));
  });

  it('does not send when another worker already holds the delivery lease', async () => {
    mocks.findMany.mockResolvedValue([{
      id: 'delivery-1', studentId: 'student-1', eventKey: 'job-1:ready',
      title: 'Ready', body: 'Collect it', url: '/jobs/job-1',
    }]);
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(publishPendingFirebaseNotifications()).resolves.toBe(0);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('releases a failed delivery lease so the scheduled worker can retry', async () => {
    mocks.findMany.mockResolvedValue([{
      id: 'delivery-1', studentId: 'student-1', eventKey: 'job-1:ready',
      title: 'Ready', body: 'Collect it', url: '/jobs/job-1',
    }]);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.send.mockRejectedValue(new Error('provider unavailable'));
    mocks.update.mockResolvedValue({ id: 'delivery-1' });

    await expect(publishPendingFirebaseNotifications()).resolves.toBe(0);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'delivery-1' },
      data: expect.objectContaining({ leaseExpiresAt: null, lastError: 'provider unavailable' }),
    }));
  });
});
