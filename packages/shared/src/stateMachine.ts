import type { JobStatus } from './types.js';

export const JOB_EVENTS = [
  'PAYMENT_CONFIRMED',
  'FRONT_REACHED',
  'OTP_VERIFIED',
  'WINDOW_EXPIRED',
  'REQUEUE',
  'GRACE_EXPIRED',
  'REJOINED',
  'PRINT_STARTED',
  'PRINT_COMPLETED',
  'PRINT_FAILED',
  'HANDED_OVER',
  'CANCEL',
] as const;
export type JobEvent = (typeof JOB_EVENTS)[number];

/**
 * The single source of truth for job status changes (printQ.md §8).
 * Every status write in the system must go through transition().
 */
const TRANSITIONS: Record<JobStatus, Partial<Record<JobEvent, JobStatus>>> = {
  pending_payment: { PAYMENT_CONFIRMED: 'queued', CANCEL: 'cancelled' },
  queued: { FRONT_REACHED: 'notified', CANCEL: 'cancelled' },
  notified: {
    OTP_VERIFIED: 'otp_verified',
    WINDOW_EXPIRED: 'no_show',
    CANCEL: 'cancelled',
  },
  no_show: { REQUEUE: 'requeued', GRACE_EXPIRED: 'expired' },
  requeued: { REJOINED: 'queued' },
  otp_verified: { PRINT_STARTED: 'printing' },
  // PRINT_FAILED returns to otp_verified so the shop can re-dispatch without a new OTP
  printing: { PRINT_COMPLETED: 'ready_for_pickup', PRINT_FAILED: 'otp_verified' },
  ready_for_pickup: { HANDED_OVER: 'completed' },
  completed: {},
  expired: {},
  cancelled: {},
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: JobStatus,
    public readonly event: JobEvent,
  ) {
    super(`Invalid job transition: ${event} from ${from}`);
    this.name = 'InvalidTransitionError';
  }
}

export function transition(from: JobStatus, event: JobEvent): JobStatus {
  const next = TRANSITIONS[from]?.[event];
  if (!next) throw new InvalidTransitionError(from, event);
  return next;
}

export function canTransition(from: JobStatus, event: JobEvent): boolean {
  return TRANSITIONS[from]?.[event] !== undefined;
}

/** States in which the job occupies a slot in a printer's queue. */
export const ACTIVE_QUEUE_STATUSES: JobStatus[] = ['queued', 'notified'];

/** Terminal states — no further transitions possible. */
export const TERMINAL_STATUSES: JobStatus[] = ['completed', 'expired', 'cancelled'];
