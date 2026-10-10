export interface Coordinates {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_M = 6_371_000;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance, accurate enough for a shop-scale geofence. */
export function distanceMeters(from: Coordinates, to: Coordinates): number {
  const lat1 = radians(from.latitude);
  const lat2 = radians(to.latitude);
  const deltaLat = radians(to.latitude - from.latitude);
  const deltaLng = radians(to.longitude - from.longitude);
  const haversine =
    Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(haversine));
}

/** Exact boundary: a student exactly on the radius is inside; anything beyond is out. */
export function isWithinRadius(distanceM: number, radiusM: number): boolean {
  return distanceM <= radiusM;
}

/** PrintQs is India-only (INR, +91, Razorpay). Generous box incl. Andaman/Nicobar and Lakshadweep. */
export const INDIA_BOUNDS = { minLat: 6.0, maxLat: 37.5, minLng: 68.0, maxLng: 98.0 } as const;
export const OUTSIDE_INDIA_MESSAGE = 'That location is outside India — check latitude/longitude';

export function isWithinIndia(latitude: number, longitude: number): boolean {
  return latitude >= INDIA_BOUNDS.minLat && latitude <= INDIA_BOUNDS.maxLat
    && longitude >= INDIA_BOUNDS.minLng && longitude <= INDIA_BOUNDS.maxLng;
}

/** A pin that moved less than this is GPS jitter / a re-capture, not a relocation needing re-review. */
export const MATERIAL_MOVE_M = 150;
