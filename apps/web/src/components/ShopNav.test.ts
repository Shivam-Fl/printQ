import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { isSessionOver, shopMeRetryDelay } from './ShopNav.js';

describe('ShopNav session guard (M8)', () => {
  it('signs out only on a real 401', () => {
    expect(isSessionOver(new ApiError(401, 'Unauthorized'))).toBe(true);
    expect(isSessionOver(new ApiError(503, 'busy'))).toBe(false);
    expect(isSessionOver(new ApiError(0, 'offline'))).toBe(false);
    expect(isSessionOver(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('retries with a capped backoff', () => {
    expect([0, 1, 2, 3, 10].map(shopMeRetryDelay)).toEqual([3_000, 6_000, 12_000, 15_000, 15_000]);
  });
});
