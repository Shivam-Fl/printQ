import { describe, expect, it, vi } from 'vitest';
import { FirebaseProjectionWriter, projectionPayload } from './projections.js';

const job = {
  id: 'job-1',
  shopId: 'shop-1',
  status: 'queued',
  assignedPrinterId: 'printer-1',
  updatedAt: new Date('2026-09-18T12:00:00.000Z'),
  nearFrontNotifiedAt: null,
  student: { firebaseUid: 'firebase-user-1' },
} as const;

describe('Firebase realtime projections', () => {
  it('contains queue state only and never exposes document, location, phone, or money fields', () => {
    const payload = projectionPayload(job, { position: 2, etaMinutes: 4 });
    expect(payload.student).toMatchObject({
      jobId: 'job-1', status: 'queued', position: 2, etaMinutes: 4, counterCodeAvailable: true,
    });
    expect(payload.shop).toEqual({
      jobId: 'job-1', status: 'queued', printerId: 'printer-1', position: 2, updatedAt: '2026-09-18T12:00:00.000Z',
    });
    expect(JSON.stringify(payload)).not.toMatch(/price|paise|phone|location|latitude|longitude|filename|originalKey/i);
  });

  it('writes each projection to a scoped deterministic document path', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const doc = vi.fn().mockReturnValue({ set });
    const writer = new FirebaseProjectionWriter({ doc });
    await writer.write(job, { position: 2, etaMinutes: 4 });
    expect(doc).toHaveBeenCalledWith('shopProjections/shop-1/jobs/job-1');
    expect(doc).toHaveBeenCalledWith('studentProjections/firebase-user-1/jobs/job-1');
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('does not create a student-readable projection before Firebase identity linking', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const doc = vi.fn().mockReturnValue({ set });
    const writer = new FirebaseProjectionWriter({ doc });
    await writer.write({ ...job, student: { firebaseUid: null } }, { position: 2, etaMinutes: 4 });
    expect(doc).toHaveBeenCalledTimes(1);
    expect(doc).toHaveBeenCalledWith('shopProjections/shop-1/jobs/job-1');
  });
});
