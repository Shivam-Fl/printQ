const MAX_RESTART_DELAY_MS = 30_000;

/** Bounded exponential backoff keeps a crashed local agent from thrashing a shop PC or API. */
export function restartDelayMs(consecutiveFailures: number): number {
  const failures = Math.max(0, Math.min(5, Math.floor(consecutiveFailures)));
  return Math.min(MAX_RESTART_DELAY_MS, 1_000 * (2 ** failures));
}
