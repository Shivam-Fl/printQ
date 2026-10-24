import { distanceMeters, type Coordinates } from '../../lib/geo.js';

/** Public discovery is deliberately more restrictive than a shop's internal state. */
export const publishedShopWhere = {
  verificationStatus: 'verified' as const,
  publishedAt: { not: null },
  // A campus is optional; a shop on a campus must have it active.
  OR: [{ campusId: null }, { campus: { is: { isActive: true } } }],
};

export interface NearbyCandidate {
  slug: string;
  name: string;
  address: string;
  campusName: string | null;
  latitude: number | null;
  longitude: number | null;
  open: boolean;
}

export interface NearbyShop {
  slug: string;
  name: string;
  address: string;
  campusName: string | null;
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

/**
 * Cheap DB prefilter for nearby search. Latitude is always bounded; longitude is
 * only bounded when the box does not cross the antimeridian or reach a pole
 * (otherwise it is skipped and the exact distance check does the work).
 */
export function nearbyBoundingBox(origin: Coordinates, maxDistanceM: number) {
  const latDelta = maxDistanceM / 111_000;
  const cos = Math.cos((origin.latitude * Math.PI) / 180);
  const lngDelta = maxDistanceM / (111_000 * Math.max(0.01, cos));
  const crossesPole = Math.abs(origin.latitude) + latDelta >= 90;
  const crossesAntimeridian = origin.longitude - lngDelta < -180 || origin.longitude + lngDelta > 180;
  return {
    latitude: { gte: origin.latitude - latDelta, lte: origin.latitude + latDelta },
    longitude: crossesPole || crossesAntimeridian
      ? undefined
      : { gte: origin.longitude - lngDelta, lte: origin.longitude + lngDelta },
  };
}
