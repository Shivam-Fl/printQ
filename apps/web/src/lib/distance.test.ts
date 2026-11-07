import { describe, expect, it } from 'vitest';
import { formatDistance } from './distance.js';

describe('formatDistance', () => {
  it('never says 0 m', () => {
    expect(formatDistance(0)).toBe('Right here (<50 m away)');
    expect(formatDistance(49)).toBe('Right here (<50 m away)');
  });
  it('rounds metres and switches to km', () => {
    expect(formatDistance(50)).toBe('~50 m away');
    expect(formatDistance(234)).toBe('~230 m away');
    expect(formatDistance(1500)).toBe('~1.5 km away');
  });
  it('picks the unit after rounding', () => {
    expect(formatDistance(994)).toBe('~990 m away');
    expect(formatDistance(995)).toBe('~1.0 km away');
    expect(formatDistance(999)).toBe('~1.0 km away');
    expect(formatDistance(1000)).toBe('~1.0 km away');
  });
});
