import { logger } from './logger.js';

const inFlight = new Set<Promise<unknown>>();

/**
 * Run non-critical follow-up work (notifications, web push / FCM delivery,
 * realtime fan-out, timers) after the request has been answered. The work
 * still runs exactly once; a failure is logged, never thrown into the request.
 *
 * Durability stays with the database (conditional UPDATE wins, idempotent
 * eventKey, realtime outbox row written in the transition transaction), so a
 * crash here only delays a push — the sweepers repair state.
 */
export function runInBackground(name: string, work: () => Promise<unknown>): Promise<unknown> {
  const task: Promise<unknown> = Promise.resolve()
    .then(work)
    .catch((err) => logger.error({ err, task: name }, 'background_task_failed'))
    .finally(() => {
      inFlight.delete(task);
    });
  inFlight.add(task);
  return task; // never rejects; lets a follow-up task keep notification order
}

/** Wait until every background task started so far (and any they start) has settled. Tests and graceful shutdown. */
export async function drainBackground(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}
