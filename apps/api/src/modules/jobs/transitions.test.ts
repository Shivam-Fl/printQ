import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    job: { updateMany: vi.fn(), findUnique: vi.fn() },
    jobEvent: { create: vi.fn() },
    realtimeOutbox: { create: vi.fn() },
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      $disconnect: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock('../../lib/prisma.js', () => ({ prisma: mocks.prisma }));
vi.mock('../../lib/logger.js', () => ({ logger: { warn: vi.fn() } }));

const { applyTransition } = await import('./transitions.js');

describe('authoritative transition outbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.job.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.job.findUnique.mockResolvedValue({ id: 'job-1', status: 'awaiting_arrival' });
    mocks.tx.jobEvent.create.mockResolvedValue({ id: 'event-1' });
    mocks.tx.realtimeOutbox.create.mockResolvedValue({ id: 'outbox-1' });
  });

  it('records the audit event and rebuildable projection delivery in the same transaction', async () => {
    await expect(applyTransition('job-1', 'pending_payment', 'CASH_SELECTED', { type: 'system' }))
      .resolves.toEqual({ id: 'job-1', status: 'awaiting_arrival' });

    expect(mocks.prisma.$transaction).toHaveBeenCalledOnce();
    expect(mocks.tx.jobEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ jobId: 'job-1', toStatus: 'awaiting_arrival', event: 'CASH_SELECTED' }),
    }));
    expect(mocks.tx.realtimeOutbox.create).toHaveBeenCalledWith({
      data: { jobEventId: 'event-1', jobId: 'job-1' },
    });
  });

  it('does not create an audit or projection record when optimistic concurrency loses', async () => {
    mocks.tx.job.updateMany.mockResolvedValue({ count: 0 });
    await expect(applyTransition('job-1', 'pending_payment', 'CASH_SELECTED', { type: 'system' })).resolves.toBeNull();
    expect(mocks.tx.jobEvent.create).not.toHaveBeenCalled();
    expect(mocks.tx.realtimeOutbox.create).not.toHaveBeenCalled();
  });
});
