/**
 * Counter-capacity queue bands.
 *
 * A shop's counter can serve `capacity` students at once. Among the shop's
 * active checked-in jobs (queue order, 1-based):
 *   positions 1..cap          -> revealed  (stable counter code visible, go now)
 *   positions cap+1..2*cap    -> arriving  ("your turn is coming up")
 *   positions 2*cap+1..       -> waiting   (position only)
 */
export type QueueBand = 'revealed' | 'arriving' | 'waiting';

export const COUNTER_CAPACITY_MIN = 1;
export const COUNTER_CAPACITY_MAX = 20;
export const COUNTER_CAPACITY_DEFAULT = 5;
export const REVEAL_GRACE_OPTIONS = [30, 60, 120] as const;
export const REVEAL_GRACE_DEFAULT = 60;

/** Pure positional band. Position is 1-based; anything else is not in line. */
export function queueBand(position: number | null | undefined, capacity: number): QueueBand | null {
  if (position == null || !Number.isInteger(position) || position < 1) return null;
  const cap = Math.max(COUNTER_CAPACITY_MIN, Math.floor(capacity));
  if (position <= cap) return 'revealed';
  if (position <= cap * 2) return 'arriving';
  return 'waiting';
}

export interface BandInput {
  id: string;
  /** Already revealed earlier (revealedAt set). Reveals are never undone. */
  revealed: boolean;
}

/**
 * Bands for an ordered queue, honouring "never un-reveal". Already revealed
 * jobs keep their band even if capacity was lowered. Free slots
 * (capacity - revealedCount) go to the earliest unrevealed jobs; the next
 * `capacity` unrevealed jobs are arriving; the rest are waiting. With no
 * sticky reveals this equals queueBand(position, capacity) for every job.
 */
export function assignBands(queue: BandInput[], capacity: number): Map<string, QueueBand> {
  const cap = Math.max(COUNTER_CAPACITY_MIN, Math.floor(capacity));
  const out = new Map<string, QueueBand>();
  let free = Math.max(0, cap - queue.filter((q) => q.revealed).length);
  let arriving = cap;
  for (const item of queue) {
    if (item.revealed) out.set(item.id, 'revealed');
    else if (free > 0) { free -= 1; out.set(item.id, 'revealed'); }
    else if (arriving > 0) { arriving -= 1; out.set(item.id, 'arriving'); }
    else out.set(item.id, 'waiting');
  }
  return out;
}
