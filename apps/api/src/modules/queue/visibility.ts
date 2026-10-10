import type { JobStatus, QueueBand } from '@printq/shared';

/**
 * The stable counter code is shown only while a job is in the REVEALED band
 * (revealedAt is set while it is queued) or once it is printed and waiting
 * for collection. ARRIVING/WAITING jobs, absent jobs and prepared-but-not-
 * checked-in jobs never receive it, in any API, socket or push payload.
 */
export function isCounterCodeAvailable(status: JobStatus, revealedAt: Date | null): boolean {
  if (status === 'ready_for_pickup') return true;
  return (status === 'queued' || status === 'notified') && revealedAt !== null;
}

/**
 * Staff may serve any revealed student without a warning: the counter can
 * handle `counterCapacity` people at once, so position 1 is no longer special.
 * Anything else (arriving/waiting, absent, not checked in) needs an override.
 */
export function isNormalCounterRelease(status: JobStatus, band: QueueBand | null): boolean {
  return (status === 'queued' || status === 'notified') && band === 'revealed';
}
