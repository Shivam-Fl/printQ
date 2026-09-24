import { describe, expect, it } from 'vitest';
import { nearbyShops, publishedShopWhere } from './discovery.js';

describe('public shop discovery', () => {
  it('requires verification, publication, and an active canonical campus', () => {
    expect(publishedShopWhere).toEqual({
      verificationStatus: 'verified',
      publishedAt: { not: null },
      campus: { is: { isActive: true } },
    });
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
