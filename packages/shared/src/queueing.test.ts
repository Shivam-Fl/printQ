import { describe, expect, it } from 'vitest';
import { isPendingScheduled, pickNextJob, type QueueCandidate } from './queueing.js';

const now = new Date('2026-07-06T10:00:00Z');
const LEAD = 10 * 60_000;

const instant = (id: string, minsAgo: number): QueueCandidate => ({
  id,
  mode: 'instant',
  queuedAt: new Date(now.getTime() - minsAgo * 60_000),
  scheduledTime: null,
});
const scheduled = (id: string, minsFromNow: number): QueueCandidate => ({
  id,
  mode: 'scheduled',
  queuedAt: new Date(now.getTime() - 12 * 3_600_000), // booked last night
  scheduledTime: new Date(now.getTime() + minsFromNow * 60_000),
});

describe('pickNextJob', () => {
  it('picks oldest instant when no scheduled jobs are due', () => {
    const pick = pickNextJob([instant('b', 5), instant('a', 20), scheduled('s', 120)], null, now, LEAD);
    expect(pick?.id).toBe('a');
  });

  it('a scheduled job inside its lead window beats instants on a fresh printer', () => {
    const pick = pickNextJob([instant('a', 20), scheduled('s', 5)], null, now, LEAD);
    expect(pick?.id).toBe('s');
  });

  it('alternates: after a scheduled promotion, an instant goes next', () => {
    const jobs = [instant('a', 20), scheduled('s1', 2), scheduled('s2', 5)];
    expect(pickNextJob(jobs, 'scheduled', now, LEAD)?.id).toBe('a');
    expect(pickNextJob(jobs, 'instant', now, LEAD)?.id).toBe('s1');
  });

  it('due scheduled jobs are served in slot order', () => {
    const pick = pickNextJob([scheduled('later', 8), scheduled('sooner', 1)], null, now, LEAD);
    expect(pick?.id).toBe('sooner');
  });

  it('an overdue slot (student booked, time passed) still counts as due', () => {
    const pick = pickNextJob([scheduled('overdue', -30)], null, now, LEAD);
    expect(pick?.id).toBe('overdue');
  });

  it('returns null when only future-slot jobs wait', () => {
    expect(pickNextJob([scheduled('s', 60)], null, now, LEAD)).toBeNull();
  });
});

describe('isPendingScheduled', () => {
  it('true outside the lead window, false inside', () => {
    expect(isPendingScheduled(scheduled('s', 60), now, LEAD)).toBe(true);
    expect(isPendingScheduled(scheduled('s', 5), now, LEAD)).toBe(false);
    expect(isPendingScheduled(instant('i', 5), now, LEAD)).toBe(false);
  });
});
