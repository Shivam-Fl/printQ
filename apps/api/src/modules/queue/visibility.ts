import type { JobStatus } from '@printq/shared';

/**
 * Counter codes are revealed automatically once a checked-in order reaches
 * the shop's near-front window. Once revealed they stay available if the
 * queue shifts or the student is marked absent, so recovery never depends on
 * getting the same position again.
 */
export function isCounterCodeAvailable(
  status: JobStatus,
  position: number | null,
  nearFrontThreshold: number,
  wasPreviouslyAvailable: boolean,
): boolean {
  if (status === 'ready_for_pickup') return true;
  if (wasPreviouslyAvailable && ['awaiting_arrival', 'queued', 'notified', 'no_show'].includes(status)) return true;
  if (status !== 'queued' && status !== 'notified') return false;
  return position !== null && position <= nearFrontThreshold;
}

/** Only the head of an active physical queue can be released without a warning. */
export function isNormalCounterRelease(status: JobStatus, position: number | null): boolean {
  return (status === 'queued' || status === 'notified') && position === 1;
}
