import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { MAX_AUTO_RETRIES, backoffMs, isRetryable } from './useResource.js';

describe('useResource helpers', () => {
  it('backs off 2s, 4s, 8s and caps at 8s', () => {
    expect([0, 1, 2, 3, 6].map(backoffMs)).toEqual([2000, 4000, 8000, 8000, 8000]);
    expect(MAX_AUTO_RETRIES).toBe(3);
  });

  it('retries transient failures and not definitive client errors', () => {
    expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetryable(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isRetryable(new ApiError(500, 'x'))).toBe(true);
    expect(isRetryable(new ApiError(502, 'x'))).toBe(true);
    expect(isRetryable(new ApiError(429, 'x'))).toBe(true);
    expect(isRetryable(new ApiError(404, 'x'))).toBe(false);
    expect(isRetryable(new ApiError(403, 'x'))).toBe(false);
  });
});
