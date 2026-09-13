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
