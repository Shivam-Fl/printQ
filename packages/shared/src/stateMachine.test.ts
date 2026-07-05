import { describe, expect, it } from 'vitest';
import { InvalidTransitionError, JOB_EVENTS, canTransition, transition } from './stateMachine.js';
import { JOB_STATUSES } from './types.js';

describe('job state machine', () => {
  it('walks the happy path end to end', () => {
    let s = transition('pending_payment', 'PAYMENT_CONFIRMED');
    expect(s).toBe('queued');
    s = transition(s, 'FRONT_REACHED');
    expect(s).toBe('notified');
    s = transition(s, 'OTP_VERIFIED');
    expect(s).toBe('otp_verified');
    s = transition(s, 'PRINT_STARTED');
    expect(s).toBe('printing');
    s = transition(s, 'PRINT_COMPLETED');
    expect(s).toBe('ready_for_pickup');
    s = transition(s, 'HANDED_OVER');
    expect(s).toBe('completed');
  });

  it('handles the no-show → requeue branch', () => {
    expect(transition('notified', 'WINDOW_EXPIRED')).toBe('no_show');
    expect(transition('no_show', 'REQUEUE')).toBe('requeued');
    expect(transition('requeued', 'REJOINED')).toBe('queued');
  });

  it('expires after the grace period', () => {
    expect(transition('no_show', 'GRACE_EXPIRED')).toBe('expired');
  });

  it('returns a failed print to otp_verified for re-dispatch', () => {
    expect(transition('printing', 'PRINT_FAILED')).toBe('otp_verified');
  });

  it('allows cancel only before release', () => {
    expect(transition('queued', 'CANCEL')).toBe('cancelled');
    expect(transition('notified', 'CANCEL')).toBe('cancelled');
    expect(() => transition('printing', 'CANCEL')).toThrow(InvalidTransitionError);
    expect(() => transition('completed', 'CANCEL')).toThrow(InvalidTransitionError);
  });

  it('rejects payment confirmation twice', () => {
    expect(() => transition('queued', 'PAYMENT_CONFIRMED')).toThrow(InvalidTransitionError);
  });

  it('terminal states accept no events at all', () => {
    for (const status of ['completed', 'expired', 'cancelled'] as const) {
      for (const event of JOB_EVENTS) {
        expect(canTransition(status, event)).toBe(false);
      }
    }
  });

  it('every state is reachable or initial (no orphan states)', () => {
    const reachable = new Set<string>(['pending_payment']);
    for (const from of JOB_STATUSES) {
      for (const event of JOB_EVENTS) {
        if (canTransition(from, event)) reachable.add(transition(from, event));
      }
    }
    expect([...JOB_STATUSES].filter((s) => !reachable.has(s))).toEqual([]);
  });
});
