import { describe, expect, it, vi } from 'vitest';
import { FirebaseProjectionWriter, projectionPayload, projectionTargets } from './projections.js';

const job = {
  id: 'job-1',
  shopId: 'shop-1',
  status: 'queued',
  assignedPrinterId: 'printer-1',
  updatedAt: new Date('2026-09-18T12:00:00.000Z'),
  revealedAt: new Date('2026-09-18T11:59:00.000Z'),
  student: { firebaseUid: 'firebase-user-1' },
} as const;

describe('Firebase realtime projections', () => {
  it('contains queue state only and never exposes document, location, phone, or money fields', () => {
    const payload = projectionPayload(job, { position: 2, etaMinutes: 4, band: 'revealed' });
    expect(payload.student).toMatchObject({
      jobId: 'job-1', status: 'queued', position: 2, etaMinutes: 4, band: 'revealed', counterCodeAvailable: true,
    });
    expect(payload.shop).toEqual({
      jobId: 'job-1', status: 'queued', printerId: 'printer-1', position: 2, band: 'revealed', updatedAt: '2026-09-18T12:00:00.000Z',
    });
    expect(JSON.stringify(payload)).not.toMatch(/price|paise|phone|location|latitude|longitude|filename|originalKey/i);
  });

  it('never signals a code outside the revealed band, even with a stale revealedAt', () => {
    const arriving = projectionPayload(job, { position: 7, etaMinutes: 4, band: 'arriving' });
    expect(arriving.student).toMatchObject({ band: 'arriving', counterCodeAvailable: false });
    const unrevealed = projectionPayload({ ...job, revealedAt: null }, { position: 1, etaMinutes: 0, band: 'revealed' });
    expect(unrevealed.student).toMatchObject({ counterCodeAvailable: false });
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

  it('refreshes every active queue projection when another job leaves the queue', () => {
    const completed = { ...job, id: 'job-0', status: 'completed' } as const;
    const laterQueuedJob = {
      ...job,
      id: 'job-2',
      student: { firebaseUid: 'firebase-user-2' },
    } as const;

    expect(projectionTargets(completed, [job, laterQueuedJob]).map((target) => target.id))
      .toEqual(['job-0', 'job-1', 'job-2']);
  });
});
