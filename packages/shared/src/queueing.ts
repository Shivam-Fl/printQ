import type { JobMode } from './types.js';

export interface QueueCandidate {
  id: string;
  mode: JobMode;
  /** payment-confirmation time — instant ordering */
  queuedAt: Date;
  /** slot time for scheduled jobs */
  scheduledTime: Date | null;
}

/**
 * Phase 2 queue policy (printQ.md §9): scheduled jobs get a real guarantee at
 * their slot, but walk-ins must not be starved. A scheduled job becomes
 * *due* `leadMs` before its slot. When both due-scheduled and instant jobs are
 * waiting, promotion alternates between the two groups (≈50/50 reserved
 * capacity), tracked by the printer's last promoted mode.
 */
export function pickNextJob(
  candidates: QueueCandidate[],
  lastPromotedMode: JobMode | null,
  now: Date,
  leadMs: number,
): QueueCandidate | null {
  const dueScheduled = candidates
    .filter((c) => c.mode === 'scheduled' && c.scheduledTime !== null && c.scheduledTime.getTime() <= now.getTime() + leadMs)
    .sort((a, b) => a.scheduledTime!.getTime() - b.scheduledTime!.getTime());
  const instant = candidates
    .filter((c) => c.mode === 'instant')
    .sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime());

  if (dueScheduled.length === 0) return instant[0] ?? null;
  if (instant.length === 0) return dueScheduled[0] ?? null;
  // both waiting → alternate; scheduled goes first on a fresh printer
  return lastPromotedMode === 'scheduled' ? instant[0]! : dueScheduled[0]!;
}

/** True when a scheduled job is not yet inside its lead window. */
export function isPendingScheduled(c: Pick<QueueCandidate, 'mode' | 'scheduledTime'>, now: Date, leadMs: number): boolean {
  return (
    c.mode === 'scheduled' &&
    c.scheduledTime !== null &&
    c.scheduledTime.getTime() > now.getTime() + leadMs
  );
}
