/** Keeps the setup checklist fresh while the shop is not live yet. DOM-free so it is unit-testable. */

export const SETUP_POLL_MS = 8000;

/** Poll only once setup has loaded and is still not ready; stop as soon as it is ready. */
export function shouldPollSetup(setup: { ready: boolean } | null): boolean {
  return setup !== null && !setup.ready;
}

interface Listenable {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

/** Calls `poll` every `intervalMs`, on window focus and when the tab becomes visible; never while hidden. Returns stop(). */
export function startSetupPolling(opts: {
  poll: () => void;
  isHidden: () => boolean;
  win: Listenable;
  doc: Listenable;
  intervalMs?: number;
}): () => void {
  const tick = () => {
    if (!opts.isHidden()) opts.poll();
  };
  const timer = setInterval(tick, opts.intervalMs ?? SETUP_POLL_MS);
  opts.win.addEventListener('focus', tick);
  opts.doc.addEventListener('visibilitychange', tick);
  return () => {
    clearInterval(timer);
    opts.win.removeEventListener('focus', tick);
    opts.doc.removeEventListener('visibilitychange', tick);
  };
}
