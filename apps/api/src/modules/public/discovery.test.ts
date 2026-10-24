import { describe, expect, it } from 'vitest';
import { nearbyShops, publishedShopWhere } from './discovery.js';

describe('public shop discovery', () => {
  it('requires verification and publication; a campus is optional but must be active when present', () => {
    expect(publishedShopWhere).toEqual({
      verificationStatus: 'verified',
      publishedAt: { not: null },
      OR: [{ campusId: null }, { campus: { is: { isActive: true } } }],
    });
  });

  it('lists a shop with no campus (campusName null), sorted by distance, anywhere in the world', () => {
    const shops = nearbyShops(
      { latitude: 51.5072, longitude: -0.1276 },
      [
        { slug: 'b', name: 'B', address: 'Pinned location', campusName: null, latitude: 51.512, longitude: -0.1276, open: true },
        { slug: 'a', name: 'A', address: 'High St', campusName: null, latitude: 51.508, longitude: -0.1276, open: false },
      ],
      2_000,
    );
    expect(shops.map((s) => s.slug)).toEqual(['a', 'b']);
    expect(shops[0]?.campusName).toBeNull();
  });

  it('returns only a rounded distance and never coordinates', () => {
    const shops = nearbyShops(
      { latitude: 12.9716, longitude: 77.5946 },
      [
        {
          slug: 'near-counter', name: 'Near Counter', address: 'Block A', campusName: 'Central Campus',
          latitude: 12.9721, longitude: 77.5946, open: true,
        },
        {
          slug: 'far-counter', name: 'Far Counter', address: 'Block Z', campusName: 'Central Campus',
          latitude: 13.2, longitude: 77.5946, open: true,
        },
      ],
      1_000,
    );

    expect(shops).toHaveLength(1);
    expect(shops[0]).toMatchObject({ slug: 'near-counter', distanceM: 60 });
    expect(JSON.stringify(shops)).not.toMatch(/latitude|longitude|exactDistance/i);
  });
});
