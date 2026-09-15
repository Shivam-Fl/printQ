import type { JobStatus } from './types.js';

export const JOB_EVENTS = [
  'PAYMENT_CONFIRMED',
  'CASH_SELECTED',
  'ARRIVED',
  'QUEUE_SKIPPED',
  'COUNTER_RELEASE',
  'FRONT_REACHED',
  'OTP_VERIFIED',
  'WINDOW_EXPIRED',
  'REQUEUE',
  'GRACE_EXPIRED',
  'REJOINED',
  'PRINT_STARTED',
  'PRINT_COMPLETED',
  'FINISHING_REQUIRED',
  'FINISHING_COMPLETED',
  'PRINT_FAILED',
  'CASH_RETURNED',
  'HANDED_OVER',
  'CANCEL',
] as const;
export type JobEvent = (typeof JOB_EVENTS)[number];

/**
 * The single source of truth for job status changes (printQ.md §8).
 * Every status write in the system must go through transition().
 */
const TRANSITIONS: Record<JobStatus, Partial<Record<JobEvent, JobStatus>>> = {
  pending_payment: { PAYMENT_CONFIRMED: 'awaiting_arrival', CASH_SELECTED: 'awaiting_arrival', CANCEL: 'cancelled' },
  awaiting_arrival: { ARRIVED: 'queued', COUNTER_RELEASE: 'otp_verified', CANCEL: 'cancelled' },
  queued: {
    FRONT_REACHED: 'notified',
    COUNTER_RELEASE: 'otp_verified',
    QUEUE_SKIPPED: 'awaiting_arrival',
    CANCEL: 'cancelled',
  },
  notified: {
    OTP_VERIFIED: 'otp_verified',
    COUNTER_RELEASE: 'otp_verified',
    QUEUE_SKIPPED: 'awaiting_arrival',
    WINDOW_EXPIRED: 'no_show',
    CANCEL: 'cancelled',
  },
  no_show: { ARRIVED: 'queued', COUNTER_RELEASE: 'otp_verified', REQUEUE: 'requeued', GRACE_EXPIRED: 'expired' },
  requeued: { REJOINED: 'queued' },
  otp_verified: { PRINT_STARTED: 'printing', CASH_RETURNED: 'cancelled' },
  // PRINT_FAILED returns to otp_verified so the shop can re-dispatch without a new OTP
  printing: {
    PRINT_COMPLETED: 'ready_for_pickup',
    FINISHING_REQUIRED: 'finishing',
    PRINT_FAILED: 'otp_verified',
  },
  finishing: { FINISHING_COMPLETED: 'ready_for_pickup' },
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
