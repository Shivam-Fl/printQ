import { describe, expect, it } from 'vitest';
import { distanceMeters, isWithinRadius } from './geo.js';

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

describe('200 m check-in zone boundary', () => {
  const shop = { latitude: 28.6139, longitude: 77.209 };
  const northOf = (metres: number) => ({ latitude: shop.latitude + metres / 111_194.93, longitude: shop.longitude });

  it('accepts 199.x m and rejects 200.x m', () => {
    expect(isWithinRadius(distanceMeters(northOf(199.5), shop), 200)).toBe(true);
    expect(isWithinRadius(distanceMeters(northOf(200.5), shop), 200)).toBe(false);
  });

  it('treats exactly the radius as inside', () => {
    expect(isWithinRadius(200, 200)).toBe(true);
    expect(isWithinRadius(200.0001, 200)).toBe(false);
  });
});
