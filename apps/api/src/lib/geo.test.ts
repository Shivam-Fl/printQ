import { describe, expect, it } from 'vitest';
import { distanceMeters } from './geo.js';

describe('distanceMeters', () => {
  it('returns zero for the same point', () => {
    expect(distanceMeters({ latitude: 28.6139, longitude: 77.209 }, { latitude: 28.6139, longitude: 77.209 })).toBe(0);
  });

  it('measures a short shop-scale distance', () => {
    const metres = distanceMeters(
      { latitude: 28.6139, longitude: 77.209 },
      { latitude: 28.6148, longitude: 77.209 },
    );
    expect(metres).toBeGreaterThan(95);
    expect(metres).toBeLessThan(105);
  });
});
