import { describe, expect, it } from 'vitest';
import { InvalidTransitionError, JOB_EVENTS, canTransition, transition } from './stateMachine.js';
import { JOB_STATUSES } from './types.js';

describe('job state machine', () => {
  it('walks the happy path end to end', () => {
    let s = transition('pending_payment', 'PAYMENT_CONFIRMED');
    expect(s).toBe('awaiting_arrival');
    s = transition(s, 'ARRIVED');
    expect(s).toBe('queued');
    s = transition(s, 'COUNTER_RELEASE');
    expect(s).toBe('otp_verified');
    s = transition(s, 'PRINT_STARTED');
    expect(s).toBe('printing');
    s = transition(s, 'PRINT_COMPLETED');
    expect(s).toBe('ready_for_pickup');
    s = transition(s, 'HANDED_OVER');
    expect(s).toBe('completed');
  });

  it('prepares a cash order without pretending an online payment happened', () => {
    expect(transition('pending_payment', 'CASH_SELECTED')).toBe('awaiting_arrival');
  });

  it('closes a failed cash print after staff physically returns the money', () => {
    expect(transition('otp_verified', 'CASH_RETURNED')).toBe('cancelled');
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

  it('waits for staff to complete manual finishing before pickup', () => {
    expect(transition('printing', 'FINISHING_REQUIRED')).toBe('finishing');
    expect(transition('finishing', 'FINISHING_COMPLETED')).toBe('ready_for_pickup');
  });

  it('allows cancel only before release', () => {
    expect(transition('awaiting_arrival', 'CANCEL')).toBe('cancelled');
    expect(transition('queued', 'CANCEL')).toBe('cancelled');
    expect(transition('notified', 'CANCEL')).toBe('cancelled');
    expect(() => transition('printing', 'CANCEL')).toThrow(InvalidTransitionError);
    expect(() => transition('completed', 'CANCEL')).toThrow(InvalidTransitionError);
  });

  it('keeps a skipped arrival paid and available without blocking the line', () => {
    expect(transition('queued', 'QUEUE_SKIPPED')).toBe('awaiting_arrival');
    expect(transition('awaiting_arrival', 'COUNTER_RELEASE')).toBe('otp_verified');
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
