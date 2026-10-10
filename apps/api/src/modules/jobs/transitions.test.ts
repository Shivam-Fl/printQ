import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    job: { updateManyAndReturn: vi.fn() },
    jobEvent: { create: vi.fn() },
    realtimeOutbox: { create: vi.fn() },
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      $queryRaw: vi.fn(),
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
    mocks.tx.job.updateManyAndReturn.mockResolvedValue([{ id: 'job-1', status: 'awaiting_arrival' }]);
    mocks.tx.jobEvent.create.mockResolvedValue({ id: 'event-1' });
    mocks.tx.realtimeOutbox.create.mockResolvedValue({ id: 'outbox-1' });
  });

  it('records the audit event and rebuildable projection delivery in the same transaction', async () => {
    // A column outside the single-statement fast path takes the transaction path.
    await expect(applyTransition('job-1', 'pending_payment', 'CASH_SELECTED', { type: 'system' }, { priceBreakdown: {} }))
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
    mocks.tx.job.updateManyAndReturn.mockResolvedValue([]);
    await expect(applyTransition('job-1', 'pending_payment', 'CASH_SELECTED', { type: 'system' }, { priceBreakdown: {} })).resolves.toBeNull();
    expect(mocks.tx.jobEvent.create).not.toHaveBeenCalled();
    expect(mocks.tx.realtimeOutbox.create).not.toHaveBeenCalled();
  });

  describe('single-statement fast path', () => {
    const sqlOf = (call: number) => {
      const sql = mocks.prisma.$queryRaw.mock.calls[call]![0] as { text: string; values: unknown[] };
      return { text: sql.text.replace(/\s+/g, ' '), values: sql.values };
    };

    it('writes the guarded UPDATE, JobEvent and outbox row in ONE parameterised statement', async () => {
      mocks.prisma.$queryRaw.mockResolvedValue([{ id: 'job-1', status: 'queued' }]);
      const when = new Date('2026-01-01T00:00:00Z');
      await expect(applyTransition('job-1', 'awaiting_arrival', 'ARRIVED', { type: 'student', id: 's1' }, {
        queuedAt: when, revealedAt: null, checkInCount: { increment: 1 }, assignedPrinterId: 'p1',
      })).resolves.toEqual({ id: 'job-1', status: 'queued' });
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
      expect(mocks.prisma.$queryRaw).toHaveBeenCalledOnce();
      const { text, values } = sqlOf(0);
      expect(text).toContain('UPDATE "Job" SET');
      expect(text).toContain('"checkInCount" = "checkInCount" + $');
      expect(text).toContain('"revealedAt" = NULL');
      expect(text).toContain('INSERT INTO "JobEvent"');
      expect(text).toContain('INSERT INTO "RealtimeOutbox"');
      // values are bound, never interpolated
      expect(text).not.toContain('p1');
      expect(values).toEqual(expect.arrayContaining(['p1', 'job-1', 'awaiting_arrival', 'queued', 'ARRIVED', 'student', 's1', when]));
    });

    it('returns null (and writes nothing else) when the status guard loses the race', async () => {
      mocks.prisma.$queryRaw.mockResolvedValue([]);
      await expect(applyTransition('job-1', 'awaiting_arrival', 'ARRIVED', { type: 'system' })).resolves.toBeNull();
    });

    it('translates the absent-timer guard into the same statement', async () => {
      mocks.prisma.$queryRaw.mockResolvedValue([{ id: 'job-1' }]);
      const now = new Date();
      await applyTransition('job-1', 'queued', 'QUEUE_SKIPPED', { type: 'system' }, { queuedAt: null }, 'ABSENT_TIMEOUT', {
        revealedAt: { not: null }, revealDeadlineAt: { lte: now },
      });
      const { text, values } = sqlOf(0);
      expect(text).toContain('"revealedAt" IS NOT NULL AND "revealDeadlineAt" <= $');
      expect(values).toContain(now);
      expect(values).toContain('ABSENT_TIMEOUT');
    });

    it('falls back to the transaction path for an unsupported guard', async () => {
      await applyTransition('job-1', 'pending_payment', 'CASH_SELECTED', { type: 'system' }, {}, undefined, { paymentStatus: 'paid' });
      expect(mocks.prisma.$queryRaw).not.toHaveBeenCalled();
      expect(mocks.prisma.$transaction).toHaveBeenCalledOnce();
    });
  });
});
