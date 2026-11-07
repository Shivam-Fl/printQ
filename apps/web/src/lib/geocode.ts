/**
 * Address search + reverse lookup: Google (Places autocomplete + Geocoder) when a browser key is
 * configured, otherwise the public geocode API proxied by our server (worldwide, no key).
 */
import { api } from '../api.js';
import { createGoogleSearch, googleMapsAvailable, googleReverseLabel } from './googleMaps.js';

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

const SUB_DISTRICT = /\b(?:sub-?district|taluka|tehsil|tahsil)$/i;

/**
 * Map labels repeat admin levels ("Naupada, Thane, Thane Subdistrict, Thane, Maharashtra, 400602, India").
 * Keep each part once, drop sub-district names and the trailing country, so the address students see stays readable.
 */
export function compactAddress(label: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of label.split(',')) {
    const part = raw.trim();
    const key = part.toLocaleLowerCase('en');
    if (!part || seen.has(key) || SUB_DISTRICT.test(part)) continue;
    seen.add(key);
    parts.push(part);
  }
  // The country is obvious to anyone in the shop's town; keep short labels whole.
  if (parts.length >= 4 && !/\d/.test(parts.at(-1) ?? '')) parts.pop();
  return parts.join(', ') || label.trim();
}

/** Compact every label and drop results that read the same (the provider often returns a road twice). */
export function dedupePlaces(results: PlaceResult[]): PlaceResult[] {
  const seen = new Set<string>();
  return results.flatMap((result) => {
    const label = compactAddress(result.label);
    const key = label.toLocaleLowerCase('en');
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...result, label }];
  });
}

/** Search is only sent on an explicit submit, never per keystroke (public API is 30/min per IP). */
export async function searchPlaces(
  query: string,
  bias?: { latitude: number; longitude: number } | null,
): Promise<PlaceResult[]> {
  if (query.trim().length < MIN_QUERY_LENGTH) return [];
  const res = await api<{ results?: PlaceResult[] }>(geocodeSearchUrl(query, bias));
  return Array.isArray(res.results) ? dedupePlaces(res.results) : [];
}

/** A search match; Google matches only fetch their coordinates when picked. */
export interface SearchHit {
  id: string;
  label: string;
  resolve: () => Promise<PlaceResult | null>;
}

/**
 * Search for the editor: Google suggestions when available (one session per editor), else the
 * API search. Google failing falls back to the API search, so search never depends on one provider.
 */
export function createPlaceSearch() {
  const google = createGoogleSearch();
  return async (query: string, bias?: { latitude: number; longitude: number } | null): Promise<SearchHit[]> => {
    if (query.trim().length < MIN_QUERY_LENGTH) return [];
    if (googleMapsAvailable()) {
      try {
        const hits = await google(query, bias);
        return hits.map((hit) => {
          const label = compactAddress(hit.text);
          return { id: hit.id, label, resolve: async () => { const at = await hit.resolve(); return at && { id: hit.id, label, ...at }; } };
        });
      } catch { /* Google unavailable: the API search below still works */ }
    }
    return (await searchPlaces(query, bias)).map((place) => ({ id: place.id, label: place.label, resolve: async () => place }));
  };
}

/** Best-effort address for a pin; null on any failure so setup never blocks. */
export async function reverseLabel(latitude: number, longitude: number): Promise<string | null> {
  if (googleMapsAvailable()) {
    try {
      const label = await googleReverseLabel(latitude, longitude);
      if (label) return compactAddress(label);
    } catch { /* fall back to the API lookup */ }
  }
  try {
    const res = await api<{ label?: string | null }>(reverseGeocodeUrl(latitude, longitude));
    return typeof res.label === 'string' && res.label.trim() ? compactAddress(res.label) : null;
  } catch {
    return null;
  }
}

/** An address may be overwritten by a lookup only while it is empty or machine-filled. */
export function addressIsReplaceable(current: string, lastAutoFilled: string | null): boolean {
  const text = current.trim();
  return text === '' || text === PINNED_LOCATION || (lastAutoFilled !== null && text === lastAutoFilled);
}
