/**
 * Request sequencing for fetch-on-type screens. Each `begin()` aborts the
 * previous request and returns a ticket; a response may only be applied while
 * its ticket is still current, so a slow older answer can never overwrite a
 * newer one (even if the underlying fetch ignores the abort signal).
 */
export interface RequestTicket {
  signal: AbortSignal;
  /** True until a newer request began (or the guard was cancelled). */
  isCurrent: () => boolean;
}

export function createLatestRequest() {
  let seq = 0;
  let controller: AbortController | null = null;
  return {
    begin(): RequestTicket {
      controller?.abort();
      controller = new AbortController();
      const mine = ++seq;
      const signal = controller.signal;
      return { signal, isCurrent: () => mine === seq && !signal.aborted };
    },
    /** Invalidate whatever is in flight (unmount, mode switch). */
    cancel(): void {
      seq += 1;
      controller?.abort();
      controller = null;
    },
  };
}

export const isAbortError = (err: unknown): boolean =>
  err instanceof DOMException ? err.name === 'AbortError' : (err as { name?: string } | null)?.name === 'AbortError';
