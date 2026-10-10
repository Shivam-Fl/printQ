import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.js';

export type ResourceStatus = 'loading' | 'slow' | 'retrying' | 'error' | 'ready';

export const SLOW_AFTER_MS = 8_000;
export const REQUEST_TIMEOUT_MS = 60_000;
export const MAX_AUTO_RETRIES = 3;

/** Backoff before automatic retry number `attempt` (0-based): 2 s, 4 s, 8 s. */
export function backoffMs(attempt: number): number {
  return Math.min(2_000 * 2 ** attempt, 8_000);
}

/**
 * Transient failures are worth retrying on their own (network down, timeout,
 * rate limit, 5xx/gateway, a 200 with a body we cannot use). 4xx answers such
 * as 404 are definitive, so the screen can say so instead of spinning.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
  return true;
}

export class MalformedResponseError extends Error {
  constructor() {
    super('Unexpected response from server');
  }
}

export interface Resource<T> {
  data: T | null;
  status: ResourceStatus;
  error: unknown;
  /** Manual retry (button). Resets the automatic retry budget. */
  retry: () => void;
}

/**
 * Loads data with an explicit lifecycle: loading -> (slow after 8 s: "waking up
 * the server") -> automatic retries with backoff -> error with a Retry button.
 * `validate` rejects structurally wrong 200 bodies so they surface as errors
 * rather than crashing render.
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<unknown>,
  deps: readonly unknown[],
  options: { validate?: (value: unknown) => value is T; enabled?: boolean } = {},
): Resource<T> {
  const { validate, enabled = true } = options;
  const [state, setState] = useState<{ data: T | null; status: ResourceStatus; error: unknown }>({
    data: null,
    status: 'loading',
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const validateRef = useRef(validate);
  validateRef.current = validate;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let attempt = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let controller: AbortController | null = null;
    const later = (fn: () => void, ms: number) => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
      return id;
    };

    const run = () => {
      controller = new AbortController();
      const current = controller;
      setState((s) => ({ data: s.data, status: attempt === 0 ? 'loading' : 'retrying', error: null }));
      const slowTimer = later(() => {
        if (!cancelled) setState((s) => (s.status === 'loading' || s.status === 'retrying' ? { ...s, status: 'slow' } : s));
      }, SLOW_AFTER_MS);
      const timeoutTimer = later(() => current.abort(), REQUEST_TIMEOUT_MS);

      loadRef.current(current.signal).then(
        (value) => {
          clearTimeout(slowTimer);
          clearTimeout(timeoutTimer);
          if (cancelled) return;
          if (validateRef.current && !validateRef.current(value)) return fail(new MalformedResponseError());
          setState({ data: value as T, status: 'ready', error: null });
        },
        (error: unknown) => {
          clearTimeout(slowTimer);
          clearTimeout(timeoutTimer);
          if (!cancelled) fail(error);
        },
      );
    };

    const fail = (error: unknown) => {
      if (isRetryable(error) && attempt < MAX_AUTO_RETRIES) {
        const wait = backoffMs(attempt);
        attempt += 1;
        setState((s) => ({ data: s.data, status: 'retrying', error }));
        later(run, wait);
      } else {
        setState((s) => ({ data: s.data, status: 'error', error }));
      }
    };

    run();
    return () => {
      cancelled = true;
      controller?.abort();
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, retry };
}
