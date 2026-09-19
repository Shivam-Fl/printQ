import { distanceMeters, type Coordinates } from '../../lib/geo.js';

/** Public discovery is deliberately more restrictive than a shop's internal state. */
export const publishedShopWhere = {
  verificationStatus: 'verified' as const,
  publishedAt: { not: null },
  campus: { is: { isActive: true } },
};

export interface NearbyCandidate {
  slug: string;
  name: string;
  address: string;
  campusName: string;
  latitude: number | null;
  longitude: number | null;
  open: boolean;
}

export interface NearbyShop {
  slug: string;
  name: string;
  address: string;
  campusName: string;
  open: boolean;
  /** Rounded so discovery never discloses the student's exact GPS relationship. */
  distanceM: number;
}

/**
 * Coordinates are supplied for one request only. Callers must not persist or
 * log the caller's location; this function returns only a rounded distance.
 */
export function nearbyShops(
  origin: Coordinates,
  candidates: NearbyCandidate[],
  maxDistanceM: number,
  limit = 20,
): NearbyShop[] {
  return candidates
    .flatMap((shop) => {
      if (shop.latitude == null || shop.longitude == null) return [];
      const exactDistanceM = distanceMeters(origin, { latitude: shop.latitude, longitude: shop.longitude });
      if (exactDistanceM > maxDistanceM) return [];
      return [{
        slug: shop.slug,
        name: shop.name,
        address: shop.address,
        campusName: shop.campusName,
        open: shop.open,
        distanceM: Math.round(exactDistanceM / 10) * 10,
        exactDistanceM,
      }];
    })
    .sort((left, right) => left.exactDistanceM - right.exactDistanceM || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map(({ exactDistanceM: _exactDistanceM, ...shop }) => shop);
}
