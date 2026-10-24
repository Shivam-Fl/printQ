/** Address search + reverse lookup against the public geocode API (worldwide, no key). */
import { api } from '../api.js';

export interface PlaceResult {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
}

export const MIN_QUERY_LENGTH = 3;
/** Label used when the owner pins the shop and no address could be found. */
export const PINNED_LOCATION = 'Pinned location';

export function geocodeSearchUrl(query: string, bias?: { latitude: number; longitude: number } | null): string {
  const params = new URLSearchParams({ q: query.trim() });
  if (bias) {
    params.set('lat', String(bias.latitude));
    params.set('lng', String(bias.longitude));
  }
  return `/api/shop/geocode?${params.toString()}`;
}

export function reverseGeocodeUrl(latitude: number, longitude: number): string {
  return `/api/shop/geocode/reverse?${new URLSearchParams({ lat: String(latitude), lng: String(longitude) }).toString()}`;
}

/** Search is only sent on an explicit submit, never per keystroke (public API is 30/min per IP). */
export async function searchPlaces(
  query: string,
  bias?: { latitude: number; longitude: number } | null,
): Promise<PlaceResult[]> {
  if (query.trim().length < MIN_QUERY_LENGTH) return [];
  const res = await api<{ results?: PlaceResult[] }>(geocodeSearchUrl(query, bias));
  return Array.isArray(res.results) ? res.results : [];
}

/** Best-effort address for a pin; null on any failure so setup never blocks. */
export async function reverseLabel(latitude: number, longitude: number): Promise<string | null> {
  try {
    const res = await api<{ label?: string | null }>(reverseGeocodeUrl(latitude, longitude));
    return typeof res.label === 'string' && res.label.trim() ? res.label.trim() : null;
  } catch {
    return null;
  }
}

/** An address may be overwritten by a lookup only while it is empty or machine-filled. */
export function addressIsReplaceable(current: string, lastAutoFilled: string | null): boolean {
  const text = current.trim();
  return text === '' || text === PINNED_LOCATION || (lastAutoFilled !== null && text === lastAutoFilled);
}
